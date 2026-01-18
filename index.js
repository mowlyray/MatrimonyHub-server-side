const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion,ObjectId  } = require('mongodb');

const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.cluq4ak.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("matrimonyhub"); //DB name
    const biodatasCollection = database.collection("biodatas"); //Collection name
    const favouoritebioCollection = database.collection("favouoritebio");

    //  Premium Biodata API with age sorting (asc/desc)
 app.get('/api/premium-biodatas', async (req, res) => {
  const sortOrder = req.query.sort === 'desc' ? -1 : 1;

  const result = await biodatasCollection
    .find({
      $or: [
        { isPremium: true },
        { isPremium: "true" },
        { membership: "premium" }
      ]
    })
    .sort({ age: sortOrder })
    .limit(6)
    .toArray();

  res.send(result);
});


    // POST - Create a new biodata with auto-generated biodataId
app.post("/api/biodata", async (req, res) => {
  try {
    const { email } = req.body;

    // Prevent duplicate email
    const existing = await biodatasCollection.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Biodata already exists for this email" });
    }

    // Find the last biodata (sorted by biodataId in descending order)
    const lastBiodata = await biodatasCollection
      .find()
      .sort({ biodataId: -1 })
      .limit(1)
      .toArray();

    //  Generate new biodataId
    const newBiodataId = lastBiodata.length > 0 ? lastBiodata[0].biodataId + 1 : 1;

    // Create new biodata with generated biodataId
    const newBiodata = {
      ...req.body,
      biodataId: newBiodataId,
      isPremium: false,   // DEFAULT
      createdAt: new Date(),
    };

    const result = await biodatasCollection.insertOne(newBiodata);

    res.status(201).json({
      message: "Biodata created successfully",
      biodata: { _id: result.insertedId, ...newBiodata },
    });
  } catch (err) {
    console.error("POST /api/biodata error:", err);
    res.status(500).json({ error: "Server error while creating biodata" });
  }
});

// PUT: Update existing biodata by ID
app.put("/api/biodata/:id", async (req, res) => {
  const { id } = req.params;
  const updatedData = req.body;

    // Remove _id if it exists
  delete updatedData._id;

  console.log("Incoming update request for ID:", id);
  console.log("Payload received:", updatedData);

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ error: "Invalid biodata ID" });
  }

  try {
    const existing = await biodatasCollection.findOne({
      email: updatedData.email,
      _id: { $ne: new ObjectId(id) },
    });

    if (existing) {
      console.log("Duplicate email found:", existing.email);
      return res.status(400).send({ message: "Email already exists in another biodata" });
    }

    const result = await biodatasCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );

    console.log("Update result:", result);

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Biodata not found" });
    }

    res.status(200).send({ message: "Biodata updated successfully", updateResult: result });
  } catch (err) {
    console.error("PUT /api/biodata/:id error:", err);
    res.status(500).send({ error: "Server error while updating biodata", details: err.message });
  }
});

app.get("/api/biodata/user/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const biodata = await biodatasCollection.findOne({ userId });
    if (!biodata) {
      return res.status(404).json({ message: "Biodata not found" });
    }
    res.status(200).json(biodata);
  } catch (err) {
    console.error("GET /api/biodata/user/:userId error:", err);
    res.status(500).json({ error: "Server error while fetching biodata" });
  }
});

    //Get All Biodatas
app.get("/biodatas", async (req, res) => {
  const search = req.query.search;

  let query = {};
  if (search) {
    query.name = { $regex: search, $options: "i" };
  }

  const result = await biodatasCollection
    .find(query)
    .sort({ biodataId: 1 })
    .limit(200)
    .toArray();

  res.send(result);
});


   // GET biodata details with role check
app.get("/api/biodata/details/:id", async (req, res) => {
  const { id } = req.params;
  const viewerEmail = req.query.email; // logged in user

  try {
    const biodata = await biodatasCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!biodata) {
      return res.status(404).send({ message: "Biodata not found" });
    }

    // find viewer biodata
    const viewer = await biodatasCollection.findOne({
      email: viewerEmail,
    });

    const isViewerPremium = viewer?.membership === "premium";

// .............................................//
    // check approved contact request
    const approvedRequest = await client
      .db("matrimonyhub")
      .collection("contactRequests")
      .findOne({
        biodataId: Number(biodata.biodataId),
        requesterEmail: viewerEmail,
        status: "approved",
      });

    const canSeeContact = isViewerPremium || approvedRequest;

    if (!canSeeContact) {
      delete biodata.email;
      delete biodata.mobile;
    }

    res.send({
      biodata,
      canSeeContact,
    });
  } catch (err) {
    res.status(500).send({ error: "Server error" });
  }
});

// User requests biodata to be premium

app.patch("/api/biodata/request-premium/:id", async (req, res) => {
  const id = req.params.id;

  const biodata = await biodatasCollection.findOne({
    _id: new ObjectId(id),
  });

  if (!biodata) {
    return res.status(404).send({ message: "Biodata not found" });
  }

  // already premium
  if (biodata.isPremium === true) {
    return res.status(400).send({
      message: "This biodata is already premium",
    });
  }

  // already requested
  if (biodata.premiumRequested === true) {
    return res.status(400).send({
      message: "Premium request already sent",
    });
  }

  await biodatasCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { premiumRequested: true } }
  );

  res.send({ message: "Premium request sent to admin" });
});


// Admin: get all premium requests
app.get("/api/admin/premium-requests", async (req, res) => {
  const result = await biodatasCollection.find({
    premiumRequested: true,
    isPremium: false
  }).toArray();

  res.send(result);
});
// Admin approve biodata premium
app.patch("/api/admin/approve-premium/:id", async (req, res) => {
  const id = req.params.id;

  const result = await biodatasCollection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        isPremium: true,
        premiumRequested: false
      }
    }
  );

  res.send(result);
});


// ************************************************ */

// Create Payment Intent API

app.post("/api/create-payment-intent", async (req, res) => {
  const { amount } = req.body;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount * 100, // cents
    currency: "usd",
    payment_method_types: ["card"],
  });

  res.send({
    clientSecret: paymentIntent.client_secret,
  });
});

// Save contact request after payment success

const contactRequestCollection = database.collection("contactRequests");

app.post("/api/contact-request", async (req, res) => {
  const request = req.body;

  const result = await contactRequestCollection.insertOne({
    ...request,
    biodataId: Number(request.biodataId), 
    amount: Number(request.amount),
    status: "pending",
    createdAt: new Date(),
    
  });

  res.send(result);
});


// Get user contact requests (MyContactRequest page)

app.get("/api/my-contact-requests/:email", async (req, res) => {
  const email = req.params.email;

  const result = await contactRequestCollection
    .find({ requesterEmail: email })
    .toArray();

  res.send(result);
});

// User Contact Delete Request
app.delete("/api/contact-request/:id", async (req, res) => {
  const id = req.params.id;

  const result = await contactRequestCollection.deleteOne({
    _id: new ObjectId(id),
  });

  res.send(result);
});


// GET – Admin All Contact Requests
app.get("/api/contact-requests", async (req, res) => {
  const result = await contactRequestCollection.find().toArray();
  res.send(result);
});


// Admin approve contact request
app.patch("/api/contact-request/approve/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const request = await contactRequestCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!request) {
      return res.status(404).send({ message: "Request not found" });
    }

    const biodata = await biodatasCollection.findOne({
      biodataId: Number(request.biodataId),
    });

    if (!biodata) {
      return res.status(404).send({ message: "Biodata not found" });
    }

    const result = await contactRequestCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "approved",
          mobile: biodata.mobile,
          email: biodata.email,
          name: biodata.name,
        },
      }
    );

    res.send({ success: true, result });
  } catch (error) {
    console.error("Approve error:", error);
    res.status(500).send({ message: "Server error" });
  }
});

// ************************************************ */

    app.post("/favouritebio", async (req, res) => {
    const { userEmail, biodataId } = req.body;

    const exists = await favouoritebioCollection.findOne({
     userEmail,
     biodataId,
    });

     if (exists) {
      return res.status(400).send({ message: "Already added to favourites" });
    }

    const result = await favouoritebioCollection.insertOne({
      ...req.body,
      createdAt: new Date(),
     });

     res.send(result);
    });

    app.get("/favouritebio/:email", async (req, res) => {
     const email = req.params.email;
     const result = await favouoritebioCollection
      .find({ userEmail: email })
      .toArray();

     res.send(result);
    });

    app.delete("/favouritebio/:email/:biodataId", async (req, res) => {
    const { email, biodataId } = req.params;

    const result = await favouoritebioCollection.deleteOne({
     userEmail: email,
     biodataId: Number(biodataId),
    });

    res.send(result);
   });
  //  .............................manageusers
app.put("/users/:id", async (req, res) => {
  const id = req.params.id;

  const result = await biodatasCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: req.body }
  );

  res.send(result);
});
// ................admin Dashboard Stats API
app.get("/api/admin/stats", async (req, res) => {
  try {
    const totalBiodata = await biodatasCollection.countDocuments();

    const maleBiodata = await biodatasCollection.countDocuments({
      biodataType: "Male",
    });

    const femaleBiodata = await biodatasCollection.countDocuments({
      biodataType: "Female",
    });

    const premiumBiodata = await biodatasCollection.countDocuments({
      isPremium: true,
    });

    // 🔥 TOTAL REVENUE
    const revenueResult = await contactRequestCollection.aggregate([
      {
        $match: { status: "approved" } // only successful purchases
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" }
        }
      }
    ]).toArray();

    const totalRevenue = revenueResult[0]?.totalRevenue || 0;

    res.send({
      totalBiodata,
      maleBiodata,
      femaleBiodata,
      premiumBiodata,
      totalRevenue,
    });
  } catch (error) {
    res.status(500).send({ error: "Stats error" });
  }
});

// POST success story (user)
// POST Got Married Success Story
// POST Got Married Success Story
app.post("/api/success-story", async (req, res) => {
  const story = req.body;

  // 🔒 check: already submitted or not
  const alreadySubmitted = await client
    .db("matrimonyhub")
    .collection("successStories")
    .findOne({ userEmail: story.userEmail });

  if (alreadySubmitted) {
    return res.status(400).send({
      message: "You have already submitted a success story",
    });
  }

  const result = await client
    .db("matrimonyhub")
    .collection("successStories")
    .insertOne({
      userEmail: story.userEmail, // 🔑 important
      selfBiodataId: story.selfBiodataId,
      partnerBiodataId: story.partnerBiodataId,
      image: story.image,
      storyText: story.storyText,
      rating: Number(story.rating),
      marriageDate: new Date(),
      createdAt: new Date(),
    });

  res.send(result);
});

app.get("/api/success-story", async (req, res) => {
  const result = await client
    .db("matrimonyhub")
    .collection("successStories")
    .find()
    .sort({ marriageDate: -1 }) // newest first
    .toArray();

  res.send(result);
});

app.get("/api/admin/success-stories", async (req, res) => {
  const result = await client
    .db("matrimonyhub")
    .collection("successStories")
    .find()
    .sort({ marriageDate: -1 })
    .toArray();

  res.send(result);
});




// ............
// GET user role
// app.get("/users/role", async (req, res) => {
//   const email = req.query.email;

//   if (!email) {
//     return res.status(400).send({ role: "user" });
//   }

//   const user = await biodatasCollection.findOne({ email });

//   if (!user) {
//     return res.send({ role: "user" });
//   }

// res.send({
//   role: user.Role?.toLowerCase() || "user"
// });
// });


  


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Matrimony server is on')
});

app.listen(port, () => {
    console.log(`Matrimony server is running on port ${port}`)
})

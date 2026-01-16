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
        .find({ isPremium: "true" })
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
  const result = await biodatasCollection
    .find()
    .sort({ biodataId: 1 }) // SORT HERE
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

    app.post('/favouritebio', async (req, res) => {
      const post = req.body;
      const result = await favouoritebioCollection.insertOne(post)
      res.send(result)
    })
    app.get('/favouritebio', async (req, res) => {
      const result = await favouoritebioCollection.find().toArray();
      res.send(result);
    })
    app.delete('/favouritebio/:biodataId', async (req, res) => {
      const biodataId = Number(req.params.biodataId);
      const query = { biodataId:biodataId};
      const result = await favouoritebioCollection.deleteOne(query);
      res.send(result);
    })

app.put("/users/membership/:email", async (req, res) => {
  try {
    const email = req.params.email; // get email from URL
    const updateData = req.body;    // get body data (e.g. { membership: "premium" })

    if (!email) {
      return res.status(400).send({ success: false, message: "Email is required" });
    }

    // query to find user
    const query = { email: email };

    // update data (set membership field)
    const updateDoc = {
      $set: updateData
    };

    const result = await biodatasCollection.updateOne(query, updateDoc, { upsert: false });

    if (result.matchedCount === 0) {
      return res.status(404).send({ success: false, message: "User not found" });
    }

    res.send({ success: true, message: "Membership updated successfully" });

  } catch (error) {
    console.error("Membership update error:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});
 app.put('/users/:id', async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const option = { upsert: true }
      const updatedRole = req.body;
      const updatedDoc = {
        $set: updatedRole
      }
      const result = await biodatasCollection.updateOne(filter, updatedDoc, option)
      res.send(result);
    })


// Delete a favourite by biodataId for a user
app.delete('/api/favourites/:userId/:biodataId', async (req, res) => {
  const { userId, biodataId } = req.params;

  try {
    const result = await favouritesCollection.deleteOne({ userId, biodataId: Number(biodataId) });
    if (result.deletedCount > 0) {
      res.send({ message: 'Favourite deleted successfully' });
    } else {
      res.status(404).send({ message: 'Favourite not found' });
    }
  } catch (error) {
    console.error('Error deleting favourite:', error);
    res.status(500).send({ message: 'Server error deleting favourite' });
  }
});

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

import mongoose from "mongoose";

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("MONGODB_URI is not set. Database persistence will be unavailable until configured.");
    return false;
  }
  try {
    mongoose.connection.on("connected", () =>
      console.log("Database connected successfully")
    );
    mongoose.connection.on("error", (err) =>
      console.error("MongoDB runtime error:", err.message)
    );
    const cleanUri = uri.replace(/\/+$/, "");
    const targetUri = cleanUri.includes("/chat-app") ? cleanUri : `${cleanUri}/chat-app`;
    await mongoose.connect(targetUri);
    return true;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    return false;
  }
};

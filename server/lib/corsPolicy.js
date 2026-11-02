// Production-safe CORS policy helper
export const isOriginAllowed = (origin) => {
  if (!origin) return true; // Allow non-browser requests
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) return true; // Allow local dev origins

  const configured = [
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  if (configured.length === 0) {
    return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:");
  }

  if (configured.includes(origin)) return true;
  if (/^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/.test(origin)) return true;
  return false;
};

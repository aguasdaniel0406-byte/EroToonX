export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        app: "nightink-app",
        worker: true
      });
    }

    return env.ASSETS.fetch(request);
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      let databaseConnected = false;
      let mediaConnected = false;

      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        databaseConnected = result?.ok === 1;
      } catch (err) {
        databaseConnected = false;
      }

      try {
        const result = await env.MEDIA.list({ limit: 1 });
        mediaConnected = Array.isArray(result.objects);
      } catch (err) {
        mediaConnected = false;
      }

      return Response.json({
        ok: databaseConnected && mediaConnected,
        app: "nightink-app",
        worker: true,
        databaseConnected,
        mediaConnected,
        adminConfigured: Boolean(env.ADMIN_TOKEN)
      });
    }

    return env.ASSETS.fetch(request);
  }
};

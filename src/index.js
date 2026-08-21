export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Estado del sistema
    if (url.pathname === "/api/health") {
      let databaseConnected = false;
      let mediaConnected = false;

      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        databaseConnected = result?.ok === 1;
      } catch {}

      try {
        const result = await env.MEDIA.list({ limit: 1 });
        mediaConnected = Array.isArray(result.objects);
      } catch {}

      return Response.json({
        ok: databaseConnected && mediaConnected,
        app: "nightink-app",
        worker: true,
        databaseConnected,
        mediaConnected,
        adminConfigured: Boolean(env.ADMIN_TOKEN)
      });
    }

    // Comprobar contraseña del administrador
    if (
      url.pathname === "/api/admin/login" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();
        const password = body.password || "";

        if (!env.ADMIN_TOKEN) {
          return Response.json(
            {
              ok: false,
              error: "ADMIN_TOKEN no configurado"
            },
            { status: 500 }
          );
        }

        if (password !== env.ADMIN_TOKEN) {
          return Response.json(
            {
              ok: false,
              error: "Clave incorrecta"
            },
            { status: 401 }
          );
        }

        return Response.json({
          ok: true,
          message: "Acceso de administrador correcto"
        });

      } catch {
        return Response.json(
          {
            ok: false,
            error: "Solicitud inválida"
          },
          { status: 400 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};

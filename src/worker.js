import { MarketRoom } from "./room.js";

export { MarketRoom };

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/room/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api","room",":code","ws"]
      const code = (parts[2] || "").toUpperCase();
      if (!ROOM_CODE_RE.test(code)) {
        return new Response("Código de sala inválido", { status: 400 });
      }
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

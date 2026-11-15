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

    if (url.pathname === "/api/donate/mercadopago" && request.method === "POST") {
      return handleMpDonation(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleMpDonation(request, env) {
  if (!env.MP_ACCESS_TOKEN) {
    return jsonResponse({ error: "Mercado Pago no está configurado" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON inválido" }, 400);
  }

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 100 || amount > 500000) {
    return jsonResponse({ error: "Monto inválido" }, 400);
  }

  const origin = new URL(request.url).origin;

  const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [
        {
          title: "Donación - Scarface Market",
          quantity: 1,
          unit_price: Math.round(amount * 100) / 100,
          currency_id: env.MP_CURRENCY || "ARS",
        },
      ],
      back_urls: {
        success: `${origin}/?donated=1`,
        failure: origin,
        pending: origin,
      },
    }),
  });

  if (!mpRes.ok) {
    console.error("Mercado Pago preference error", mpRes.status, await mpRes.text());
    return jsonResponse({ error: "No se pudo crear el pago" }, 502);
  }

  const preference = await mpRes.json();
  return jsonResponse({
    init_point: preference.init_point,
    sandbox_init_point: preference.sandbox_init_point,
  });
}

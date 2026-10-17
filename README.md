# Mercado de Asociados — Scarface 1920

Mercado virtual compartido para jugar en mesa con *Scarface 1920*: las 60
cartas de Asociado base, en español, sincronizadas en tiempo real entre
todos los jugadores de una misma "sala" vía WebSocket (Cloudflare Workers +
Durable Objects).

## Qué incluye

- Mercado con 4 espacios de Asociados de nivel 1–3 y 2 de nivel 4–5.
- "Todas las demás cartas" debajo del mercado, para buscar y reponer un
  espacio vacío a mano (no al azar).
- Mover una carta: toca el origen (carta) y luego el destino (espacio
  vacío, otra carta para intercambiar, o la pila de Descarte) — en cualquier
  orden.
- Zoom: el botón 🔍 de cada carta abre la imagen completa en grande para
  leer el texto; se cierra con la X o tocando fuera.
- Cartas en español editadas sobre el arte original (no un panel de texto
  aparte): se borró y volvió a escribir solo el nombre y las dos habilidades
  de cada carta, usando los mismos íconos de las cartas (matón, dinero,
  nivel de crimen, arma, alcohol, auto, camión, policía y los 6 símbolos de
  tipo de crimen) en vez de palabras. El resto —ilustración, estadísticas,
  marco, estrellas y número— es el escaneo original sin tocar.
- "Reiniciar mercado": manda las 6 cartas actuales al descarte (con
  confirmación). El descarte es expandible y también se puede recuperar una
  carta de ahí.
- Una sala por código de 4 letras; cualquiera con el enlace ve y mueve las
  mismas cartas en vivo.
- Responsive: probado en escritorio y en ancho de móvil (390px).

## Desarrollo local

```bash
npm install
npm run dev
```

Abre `http://localhost:8787`.

## Despliegue a Cloudflare

```bash
npx wrangler login
npm run deploy
```

Esto crea/actualiza el Worker `scarface-market` con sus assets estáticos y
el Durable Object `MarketRoom`. No requiere ninguna otra cuenta ni servicio.

## Estructura

- `src/worker.js` — entrada del Worker: sirve los assets estáticos y
  enruta `/api/room/:code/ws` al Durable Object de esa sala.
- `src/room.js` — Durable Object `MarketRoom`: estado del mercado
  (`marketLow`, `marketHigh`, `discard`), validación de movimientos y
  difusión por WebSocket a todos los conectados de la sala.
- `src/cards-meta.js` — id + nivel de cada carta (para validar en el
  servidor a qué nivel del mercado pertenece).
- `data/cards.json` — base de datos bilingüe de las 60 cartas (nombre,
  tipo de crimen, músculo, influencia, nivel, habilidad y habilidad de
  combinación, en inglés y español).
- `data/icons/` — los 14 íconos reales de las cartas (matón, dinero, nivel
  de crimen, arma, alcohol, auto, camión, policía y los 6 símbolos de tipo
  de crimen), recortados de las propias cartas y con el fondo quitado.
- `data/generate_spanish_cards.py` — el script principal: por cada carta,
  detecta dónde termina la ilustración y dónde empieza el pie (estrellas),
  borra solo ese bloque de texto y vuelve a escribir el nombre y las dos
  habilidades en español ahí, intercalando los íconos de `data/icons/` en
  vez de las palabras Matón/Dinero/Arma/etc. Genera las 60 imágenes finales
  en `assets/cards/`. Volver a correrlo si se edita `cards.json`.
- `data/slice_cards.py` — script previo que solo recortaba el arte (sin
  reescribir texto); quedó como referencia, ya no es el que genera
  `public/assets/cards/`.
- `public/` — frontend estático (HTML/CSS/JS sin frameworks) y las 60
  cartas finales en español en `public/assets/cards/` (copia de
  `assets/cards/`).

## Notas y limitaciones conocidas

- **Texto de las cartas**: no encontré una edición en español de estas
  cartas en BGG (no pude navegar BGG directamente por el bloqueo 403 del
  sitio a accesos automatizados), así que el español sale de traducir el
  PDF de texto en inglés que me pasaste, con un glosario fijo de términos
  del juego. La tipografía del título usa Impact y el cuerpo Arial Bold
  (no son exactamente las fuentes originales de Redzen Games, pero son muy
  parecidas) — si tenés las fuentes reales, decime y las cambio en
  `generate_spanish_cards.py`.
- **Expansión / cartas propias**: según lo hablado, queda para otra etapa.
  El modelo de datos (`cards.json` + `cards-meta.js`) está pensado para
  que agregar cartas nuevas sea sencillo cuando llegue ese momento.
- **Derechos de las imágenes**: las ilustraciones son del juego publicado
  por Redzen Games; este mercado es una herramienta de fan hecha para
  jugar con tu propia copia física, no una redistribución comercial.
- Las partidas en memoria usan un código de sala de 4 caracteres; cualquiera
  que tenga el enlace puede unirse y mover cartas (no hay contraseña ni
  roles de jugador).

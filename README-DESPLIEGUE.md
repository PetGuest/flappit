# FLAPS Signage — guía de despliegue

Qué hay en esta carpeta:

- `server.js` — el servidor: cuentas, pareo de pantallas por código, estado por pantalla y push en vivo por WebSocket. Base de datos SQLite (un archivo, sin nada que instalar aparte).
- `web/tv.html` — la página que abre el televisor (`/tv`). Muestra el código de vinculación y luego el panel en vivo. Si cae internet, sigue girando con lo último recibido.
- `web/panel.html` — el panel de control (`/panel`): login/alta, vincular pantallas, y el editor completo escribiendo sobre el tablero.
- `.env.example` — variables de configuración.

## Probar en tu ordenador (5 minutos)

1. Instala Node.js 18 o superior (nodejs.org).
2. En esta carpeta: `npm install` y después `npm start`.
3. Abre `http://localhost:3000/panel` → crea tu cuenta.
4. Abre `http://localhost:3000/tv` en otra pestaña (o en la TV de casa) → verás el código de 4 letras.
5. Escríbelo en el panel → la pantalla queda vinculada y todo lo que edites aparece girando al instante.

## Desplegar en internet (opción sencilla: Railway o Render)

1. Sube esta carpeta a un repositorio de GitHub.
2. En railway.app (o render.com): "New project" → conecta el repositorio.
3. Variables de entorno: copia las de `.env.example` (pon un `SESSION_SECRET` largo y aleatorio).
4. Añade un volumen/disco persistente y apunta `DB_FILE` a él (para no perder la base de datos al redesplegar).
5. Conecta tu dominio (p. ej. `app.flapsapp.com`) en los ajustes del proyecto. El HTTPS lo dan hecho.

## Desplegar en un servidor propio (opción pro: Hetzner ~5 €/mes)

1. Crea un servidor Ubuntu, instala Node 18+ y copia esta carpeta.
2. `npm install --omit=dev` y arranca con systemd o `pm2 start server.js`.
3. Pon delante Caddy o Nginx para HTTPS (Caddy: 2 líneas de configuración y certificado automático).

## Activar los cobros (Stripe)

El cobro por suscripción está completo: alta (checkout), activación automática por webhook, caducidad de la prueba de 14 días con bloqueo del panel, y portal del cliente para cambiar plan/tarjeta o cancelar. `stripe` ya está en `package.json` (se instala con `npm install`).

1. Crea cuenta en stripe.com → Productos → crea "FLAPS 1 pantalla" y "FLAPS 3 pantallas" con precio mensual y anual (4 precios en total).
2. Copia los 4 `price_...` y tu `sk_live_...` a las variables de entorno (ver `.env.example`).
3. Crea el **webhook**: en Stripe → Developers → Webhooks → "Add endpoint", URL `https://TU-DOMINIO/api/stripe/webhook`. Suscríbelo a los eventos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copia el `whsec_...` a `STRIPE_WEBHOOK_SECRET`.
4. Activa el **Customer Portal** en Stripe (Settings → Billing → Customer portal) para que el botón "Gestionar suscripción" funcione.
5. En pruebas locales, para que Stripe pueda llamar al webhook usa la Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe/webhook` (te da un `whsec_...` de prueba).

Sin estas variables el servicio funciona igual en modo prueba (14 días); simplemente no cobra.

## Conectar la landing

En la landing (`flaps-landing.html` y `flaps-registro.html`), los botones de registro apuntan a `flaps-registro.html`, que llama a `POST /api/register`. Cuando el backend esté desplegado en el mismo dominio, el alta funciona sola y redirige a `/panel`. Mientras tanto, la página muestra el modo "lista de espera" por email.

## Qué falta para v2 (apuntado, no bloqueante)

- Recuperación de contraseña por email.
- Programación horaria de pantallas (franjas por horas).
- Subida de logo como imagen (ahora es texto).
- Vídeo/foto plena: migrar a almacenamiento de objetos + CDN y caché en la TV (hoy el vídeo se sirve desde disco y necesita conexión); cuotas por plan; borrado del fichero al eliminar el contenido.

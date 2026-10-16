# Instagram: primera conexión y recepción de eventos

Esta etapa conecta UNA cuenta profesional de prueba con UN usuario de Conversa. Valida el token con Instagram y prepara un receptor de webhooks. No implementa OAuth para clientes, envíos de DMs, respuestas a comentarios, calendario de publicaciones ni sincronización con la bandeja del simulador. Las seis opciones seleccionadas en Meta no sustituyen la revisión de permisos.

## Actualizar la VM

Si ya tienes datos, conserva una copia de seguridad como indica ACTUALIZAR_BACKEND.md. El despliegue conserva el volumen de datos y certificados y puede interrumpir brevemente el servicio.

En SSH de la VM conversa-app:

```bash
(
set -e
cd ~
curl -fL https://github.com/luisqui92/Conversa/archive/refs/heads/main.zip -o conversa-instagram.zip
unzip -o conversa-instagram.zip -d conversa-instagram-v3
cd ~/conversa-instagram-v3/Conversa-main
sudo bash deploy-vm.sh
)
```

No usar `docker compose down -v`. Si todavía no existe un usuario de Conversa, créalo primero con `sudo docker compose -f compose.vm.yaml exec api node backend/admin.mjs create-user` desde la carpeta nueva.

## Introducir credenciales en privado

```bash
cd ~/conversa-instagram-v3/Conversa-main
sudo docker compose -f compose.vm.yaml exec api node backend/instagram.mjs setup
```

Solicita:

1. El correo del usuario EXISTENTE con el que inicias sesión en Conversa.
2. El token de acceso generado en Meta para la cuenta profesional de Instagram. Se pega oculto, sin caracteres en pantalla. El comando valida el token mediante `/me` de la API de Instagram y muestra el usuario confirmado antes de guardar nada.
3. La clave secreta de la **app de Instagram**, visible en Meta → Conversa → API de Instagram → Configuración de la API con inicio de sesión de Instagram. Se pega oculta. Este dato permite comprobar las firmas de las notificaciones. No utilizar claves de Chatgo ni de otras apps. Un formato válido no demuestra que la clave sea la correcta: la entrega de un evento firmado comprobará la configuración completa.

Las credenciales quedan en `/data/instagram.credentials.json` dentro del volumen privado, con permisos 600. No están cifradas en disco por la aplicación; los administradores de la VM y los respaldos de ese volumen pueden acceder a ellas. No se copian al directorio web, GitHub, localStorage ni a respuestas de la API. No pegarlas en comandos, chat o capturas.

El asistente muestra una URL de devolución y un token de verificación nuevo. El token de verificación es distinto del token de acceso; copia solo esos valores a Meta. Una configuración previa pide escribir REEMPLAZAR antes de actualizarla. Esta versión admite una conexión piloto, no múltiples clientes conectando cuentas por sí mismos. Cambiar de usuario propietario no transfiere eventos previos.

## Registrar el webhook en Meta

En el apartado 3 de la misma app:

- URL de devolución de llamada: `https://cc.chatgo.ia.bo/api/webhooks/instagram`.
- Token de verificación: el que acaba de mostrar el comando; NO el token de acceso de Instagram.
- Dejar apagada la opción de certificado de cliente; el receptor usa la firma `X-Hub-Signature-256`.
- Pulsar Verificar y guardar. Después habilitar la suscripción de la cuenta en el apartado 2 y seleccionar los campos de comentarios y mensajes que Meta ofrezca y autorice para esta configuración.

Si Meta rechaza la verificación, comprobar que se instaló esta versión, el correo existe y el asistente terminó sin error. La URL no funcionará para verificación antes de guardar las credenciales. No añadir parámetros secretos al navegador para probarla manualmente.

El panel de Meta puede exigir publicar la app para recibir webhooks. Aceptar el rol de evaluador o generar un token no equivale a publicar ni aprobar permisos para clientes externos. Completar los requisitos que muestre Meta; este código no evita sus controles. Los eventos de ejemplo con otro identificador de cuenta se reconocen pero no se guardan.

## Comprobar recepción

Desde la VM, sin mostrar credenciales:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/instagram.mjs status
```

Muestra cuenta, propietario, fecha de validación y número de entradas recibidas. El token se valida al configurar, no en cada consulta de estado; si vence, volver a generar y ejecutar setup. La suscripción de Meta se configura por separado.

También, con sesión iniciada en el dominio, están disponibles:

- `/api/integrations/instagram`: metadatos y modo `receive-only`, sin credenciales.
- `/api/integrations/instagram/events`: últimas 20 entradas de webhook del usuario autenticado. Pueden contener nombres y textos de mensajes; no compartir capturas con datos personales.

El receptor valida HMAC-SHA256 sobre el cuerpo original y filtra por ID de cuenta validado con Instagram. Rechaza firmas incorrectas y limita el tamaño a 1 MiB. Deduplica entradas idénticas y conserva como máximo 2.000 entradas por usuario. Solo muestra los últimos siete días; elimina entradas vencidas al recibir otro webhook. No hay trabajo periódico de borrado y las copias de seguridad tienen su propia conservación.

No se generan respuestas ni DMs al recibir eventos. Antes de activar envíos faltan asociación entre publicación real y campaña, permisos efectivos, ventanas de respuesta del proveedor, cola de envíos, control de reintentos y confirmación del resultado antes de anunciar un DM. Facebook/Messenger y TikTok se conectan por separado.

## Respaldo y pruebas

El respaldo SQLite conserva eventos, pero NO incluye el archivo separado de credenciales. Guardar las credenciales y el token de verificación en un gestor privado o volver a configurar ante una restauración. No subir archivos del volumen a GitHub.

```bash
node checks.mjs
node backend/checks.mjs
node backend/instagram-checks.mjs
```

Pasan los 56 casos del simulador, 11 pruebas reportadas del backend y 10 del receptor. La nueva suite usa solicitudes en proceso y un proveedor simulado. Se comprobó además HTTP local real para health y receptor sin configurar. No se ejecutaron llamadas con credenciales reales, contenedores ni entregas de Meta desde este entorno. La nueva versión requiere instalación y verificación en la VM.

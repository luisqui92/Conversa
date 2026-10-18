# Panel de operaciones de Conversa

El inicio de sesión abre `/#dashboard`. Usa las conexiones y reglas ya guardadas en el volumen de la VM: no hace falta volver a introducir los tokens para instalar este panel.

## Qué incluye

- **Resumen:** cuentas configuradas, respuestas públicas y DMs aceptados por Meta, automatizaciones activas y resultados que necesitan atención.
- **Actividad:** comentarios y mensajes entrantes disponibles, filtros por canal y resultado, búsqueda y detalle del comentario → respuesta pública → DM.
- **Automatizaciones:** mensajes de cada publicación, creación, edición, pausa y reactivación desde la cuenta del propietario.
- **Canales:** Instagram y Facebook vinculados, cantidad de entradas recientes y estado guardado de autorización de Facebook. Instagram todavía no registra vencimiento ni renovación automática.
- **Explorar demo:** conserva la bandeja, campañas, prospectos y planes ficticios del prototipo, identificados como datos de ejemplo.

Las métricas de envíos consultan todos los registros conservados de los últimos siete días; no se calculan a partir de las veinte filas visibles. La actividad consulta las veinte últimas entradas y las veinte últimas automatizaciones por canal. Por eso puede no estar disponible el texto o nombre original de un envío antiguo. Los eventos entrantes sin automatización asociada se muestran como recibidos, sin atribuirles un envío.

“Aceptado por Meta” significa que la API devolvió un ID para esa fase. No confirma lectura, recepción en la bandeja principal ni notificación en la campanita. Los mensajes entrantes son consultables; la respuesta manual desde el panel todavía no está implementada. No hay conexión de IA, alta autónoma mediante OAuth ni cobros.

## Instalar en la VM existente

Ejecutar en el **SSH de Google Cloud**:

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

Conserva `conversa-demo_conversa_data`, sus credenciales, usuarios, reglas y eventos. Hay un reinicio breve del API para instalar las rutas nuevas. No ejecutar `docker compose down -v`.

Abrir **https://cc.chatgo.ia.bo/#dashboard**, recargar e iniciar sesión con la cuenta existente. Verificar que aparezcan las cuentas configuradas y las reglas actuales antes de editar. No es necesario publicar otra app de Meta ni cambiar sus webhooks.

## Notificaciones en el panel

La campana de la barra superior reúne los resultados de Instagram y Facebook. Al confirmar tanto la respuesta pública como el DM, aparece **Respuesta pública y DM enviados**, con la aclaración de que Meta aceptó ambos envíos. Un rechazo o un resultado incierto genera un aviso diferente. La campana no confirma lectura ni notificación en la red social.

- Los avisos se guardan en SQLite junto con la transición de estado; recibir el mismo evento o reiniciar no duplica el aviso.
- Las novedades se consultan cada cinco segundos mientras la pestaña está visible. Si el panel ya estaba abierto, un aviso emergente anuncia los resultados nuevos. Con la pestaña cerrada se siguen guardando para la próxima sesión.
- Abrir un aviso lleva al detalle de la actividad y marca ese aviso como leído. **Marcar todas como leídas** solo afecta a los avisos existentes hasta el último ID consultado, conservando los que lleguen durante la operación.
- La lectura se conserva en el servidor para la cuenta del usuario, incluso entre navegadores. Cada usuario solo consulta avisos de las cuentas que tiene configuradas.
- Se conservan durante siete días; la lista muestra los últimos treinta y el contador incluye todos los avisos pendientes del período. La depuración se realiza al consultar las notificaciones.
- La instalación no genera avisos retroactivos por automatizaciones completadas antes de esta versión.

Las rutas privadas son `GET /api/notifications`, `GET /api/notifications/:id` y `POST /api/notifications/read`. Marcar lectura exige sesión, JSON y el mismo origen, con los mismos controles que las otras mutaciones del panel. Los avisos no contienen tokens, claves ni copias de los mensajes.

## Guardar automatizaciones

1. Entrar en **Automatizaciones** y elegir **Editar mensajes**, o **Nueva automatización**.
2. Para una regla nueva, elegir un canal configurado y el ID de contenido de Meta. No admite pegar la URL del post. En Facebook se admite `ID_PAGINA_ID_POST`; debe corresponder a la página conectada. En Instagram se usa el ID numérico del contenido.
3. Escribir los dos mensajes. En Facebook, `{autor}` se convierte en la mención del autor que figura en el webhook firmado; esto no garantiza una notificación. Instagram no sustituye esa variable.
4. **Guardar y activar** responderá a comentarios nuevos de otras cuentas en esa publicación. Mantiene el límite del piloto: 30 flujos nuevos por hora y canal, sin filtro de palabras.
5. **Pausar** detiene pendientes de esa publicación; una solicitud en curso puede terminar. Una regla pausada permite editar mensajes y conservar la pausa.

Al cambiar los textos o reactivar una regla, se establece un nuevo punto de activación y se cancelan los pendientes de la configuración anterior. No se procesan comentarios antiguos ni se reintentan fallidos o resultados inciertos. Los textos ya enviados y sus resultados se conservan en cada actividad.

## Acceso y concurrencia

Las consultas usan la sesión del usuario. Las mutaciones son `PUT /api/integrations/{instagram|facebook}/automation`, requieren sesión, el mismo origen HTTPS y JSON. El servidor consulta el propietario configurado, valida los campos y usa una transacción SQLite con versión de regla. Una pestaña antigua recibe HTTP 409 en vez de sobrescribir cambios de otra pestaña o de la CLI.

Los tokens y claves siguen en los archivos privados del volumen. Las respuestas del panel no los incluyen. La interfaz no prueba la autorización en vivo ni renueva tokens al abrir la página: muestra la última comprobación de Facebook y avisa cuando la vigencia de Instagram no está registrada.

## Verificación

Pruebas nuevas de permisos, aislamiento, conflictos de reglas, conteos completos, plantilla de autor y ejecución público → DM:

```bash
node backend/panel-checks.mjs
node backend/notification-checks.mjs
```

También se comprobaron en Chromium el inicio de sesión, navegación, filtros, detalle, edición, pausa/reactivación, creación de reglas, versión móvil de 390 px y conservación de la demo. La revisión usa SQLite temporal y datos ficticios; no envía mensajes a cuentas reales. El contenedor también se construyó: las pruebas del panel y GET /api/health pasaron dentro de la imagen. Las pruebas locales no sustituyen la verificación de la instalación en la VM.

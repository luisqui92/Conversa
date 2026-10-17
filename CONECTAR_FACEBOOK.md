# Piloto de Facebook y Messenger

Se conecta una página de Facebook a un usuario de Conversa, con credenciales, eventos y reglas separados de Instagram. La primera página elegida por el usuario es **LUKMI SRL Innovación y Tecnología**, ID **309667913276491**. La consulta de páginas autorizadas mostró MODERATE, MESSAGING y MANAGE, entre otras tareas; eso permite avanzar a la prueba, pero no acredita todos los permisos efectivos ni la aprobación para clientes externos.

Si la conexión existente dejó de responder con código 190, usar
[RENOVAR_FACEBOOK.md](RENOVAR_FACEBOOK.md). El nuevo asistente amplía la autorización
de usuario antes de obtener el token de página y consulta la caducidad con Meta.

## Instalar la actualización en la VM existente

```bash
(
set -e
cd ~
curl -fL https://github.com/luisqui92/Conversa/archive/refs/heads/main.zip -o conversa-instagram.zip
unzip -o conversa-instagram.zip -d conversa-instagram-v3
cd ~/conversa-instagram-v3/Conversa-main
sudo bash deploy-vm.sh
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs setup 309667913276491
)
```

El despliegue puede interrumpir brevemente el servicio. Los datos y credenciales de Instagram permanecen en el volumen existente. No ejecutar `docker compose down -v`.

El asistente solicita:

1. El correo de un usuario existente de Conversa.
2. El token de **USUARIO** generado en el Explorador de Graph para la app nueva Conversa, con los permisos de páginas y Messenger ya concedidos. Se pega oculto. Se consulta `/me/accounts` por el servidor, se elige únicamente el ID solicitado y se valida su token mediante `/me`. Se admiten las primeras 100 páginas de esa respuesta.
3. La clave secreta de la app de Meta **Conversa → Configuración de la app → Básica**. Se pega oculta. No utilizar la clave específica de la app de Instagram ni las claves de otras apps del usuario.

El token de usuario se amplía primero por el servidor y luego obtiene el token de página. Los dos tokens de usuario solo se utilizan en memoria. Meta debe confirmar tipo, app, página y caducidad antes de guardar. Se conserva el token de página, su identidad y diagnóstico en `/data/facebook.credentials.json`, con permiso 600. No hay cifrado de ese archivo por la aplicación; los administradores de la VM pueden acceder a él. No se imprime ni devuelve por la API. Los archivos de Instagram y Facebook son distintos y quedan fuera del contenido web y de GitHub.

## Configurar el webhook de Facebook en Meta

Al terminar, el asistente imprime:

- URL: `https://cc.chatgo.ia.bo/api/webhooks/facebook`.
- Un token de verificación nuevo, distinto del token de acceso y del verificador de Instagram.

En la misma app Conversa, configurar esos valores para el objeto **Page / Página** de los webhooks de Facebook/Messenger. Según la interfaz, puede estar en Administrar páginas → Webhooks o en Messenger → Webhooks. Verificar y guardar. Suscribir los campos `feed`, `messages` y `messaging_postbacks` que corresponden al piloto. No reemplazar la configuración del objeto Instagram. Si Meta muestra formularios separados para Page y Messenger, usar para Facebook la URL y el verificador del asistente de Facebook, conservando el de Instagram para Instagram.

Después de guardar el callback y los campos en Meta, suscribir la página a la app:

```bash
cd ~/conversa-instagram-v3/Conversa-main
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs subscribe
```

Esta orden cambia la suscripción de la app Conversa en la página elegida y pide confirmación a Meta para `feed,messages,messaging_postbacks`. No altera otras apps. Configurar campos a nivel de app y suscribir la página son dos pasos diferentes. Se necesitan permisos efectivos, incluida la administración de metadatos; una tarea de moderación por sí sola no garantiza todos los accesos.

## Comprobar recepción

Desde otra cuenta, comentar una publicación de la página elegida y enviar un mensaje a esa página por Messenger. Consultar:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs status
```

Con sesión de Conversa iniciada:

- `https://cc.chatgo.ia.bo/facebook/`: actividad real de Facebook.
- `https://cc.chatgo.ia.bo/api/integrations/facebook/events`: últimas veinte entradas recibidas del usuario autenticado. Pueden contener datos personales; no compartirlos innecesariamente.

El receptor valida firmas HMAC-SHA256 de la app de Meta, el objeto `page` y el ID de página elegido. Eventos ficticios de otra página se reconocen pero se descartan. Verificar el callback no demuestra entrega real ni habilita por sí solo respuestas automáticas. La primera instalación conserva el modo de recepción hasta que se activa una regla.

## Activar una publicación después de comprobar el primer evento

Tomar el `post_id` exacto del evento `feed` → `value` del comentario. No usar el enlace público ni el ID del comentario. Los IDs de Facebook pueden tener formato `PAGINA_PUBLICACION`.

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs enable ID_POST_REAL "Te mandé información por Messenger. Revisa tus solicitudes si no aparece." "hola soy yo yo puedo con todo"
```

Sustituir `ID_POST_REAL` por el identificador comprobado. La orden activa envíos reales para comentarios nuevos de esa página y publicación: primero respuesta pública, después privado al autor por Messenger. No procesa el historial ya recibido. Los textos se pueden cambiar ejecutando enable con los textos nuevos; las acciones pendientes de la versión anterior se cancelan. No hay seguimiento automático de los mensajes entrantes de Messenger en esta etapa.

Pausar:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs disable ID_POST_REAL
```

Una solicitud en curso puede terminar. La pausa se aplica al siguiente paso pendiente.

## Mencionar al autor en la respuesta automática

Para probar una mención real, coloca `{autor}` en el texto público de la regla:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/facebook.mjs enable 309667913276491_1554451656687306 "{autor} Te mandé info por Messenger. Si no lo ves, revisa Solicitudes." "hola soy yo yo puedo con todo"
```

El receptor sustituye `{autor}` por `@[ID_AUTOR]` usando únicamente el ID del
comentario que llegó en el webhook firmado. Congela el texto en la cola por comentario;
no usa el nombre visible, el administrador de la página ni otro autor del historial.
La expansión es exclusiva del texto público de Facebook y debe quedar dentro de 1.000
caracteres. Un autor no numérico o un texto demasiado largo se descarta sin envíos.
Las reglas sin `{autor}` conservan su texto. Instagram no interpreta este marcador.

Ejecutar enable con el texto cambiado actualiza la fecha de activación: probar con
un comentario nuevo después de ejecutar la orden. No modifica respuestas ya publicadas
ni repite los mensajes del historial. Se mantiene el orden solicitud pública confirmada
→ solicitud de privado, con deduplicación y detención ante errores.

En la VM, la herramienta de prueba separada obtuvo `message_tags` con el autor para
una respuesta de LUKMI, usando su webhook guardado. Después de activar la nueva
plantilla, una captura del usuario mostró el nombre enlazado en azul dentro de la
respuesta habitual. La notificación no se confirmó con esa captura. No se garantiza
que todas las cuentas permitan la mención ni que Facebook entregue una alerta.

Diagnóstico individual: [PROBAR_MENCION_FACEBOOK.md](PROBAR_MENCION_FACEBOOK.md).

## Límites y resultados

El piloto procesa comentarios nuevos de tipo `feed` / `item: comment` / `verb: add`, con identidad del autor y publicación seleccionada. Descarta ediciones, borrados, comentarios propios y respuestas a otros comentarios. Utiliza una ventana conservadora de diez minutos y un máximo de treinta flujos por página y hora. No hay tratamiento específico de publicaciones en vivo; usar una publicación normal para la primera prueba.

Se guardan fases e IDs de confirmación en SQLite, deduplicando por página y comentario. Una respuesta pública confirmada permite intentar el privado; un fallo público lo impide. Un privado rechazado conserva el resultado público anterior. Los resultados inciertos de red o interrupción se detienen sin reintentos automáticos para evitar duplicados. Revisar la plataforma antes de cualquier intervención manual. La aceptación de la API no demuestra lectura ni llegada a la bandeja principal, y el orden visual puede diferir del orden de nuestras solicitudes.

Los eventos y tablas de reglas/acciones de Facebook están separados de los de Instagram y filtrados por usuario. Los eventos visibles se limitan a siete días y 2.000 entradas por usuario/canal. Los registros de acciones se depuran siete días después de su actualización al recibir nuevos eventos. Los respaldos SQLite incluyen esas tablas, pero las credenciales se respaldan por separado.

## Referencias y pruebas

El código utiliza Graph API v26.0 y estas operaciones. Las llamadas de página llevan
el token en Authorization; el intercambio y diagnóstico de credenciales se describen
en [RENOVAR_FACEBOOK.md](RENOVAR_FACEBOOK.md#transporte-y-almacenamiento).

- Obtener páginas: `GET /me/accounts?fields=id,name,access_token,tasks&limit=100`.
- Comprobar token de página: `GET /me?fields=id,name`.
- Suscribir página: `POST /{page-id}/subscribed_apps`.
- Responder al comentario: `POST /{comment-id}/comments`, con `message`.
- Private reply: `POST /{page-id}/messages`, con `recipient.comment_id` y `message.text`.

Referencias: [colección oficial de Facebook](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api), [Messenger](https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api), [private replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/) y [Page subscribed apps](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/). Las referencias directas de Meta pueden no estar accesibles desde este entorno; la validación final de permisos y compatibilidad se realiza desde la VM con la cuenta real.

```bash
node checks.mjs
node backend/checks.mjs
node backend/instagram-checks.mjs
node backend/instagram-automation-checks.mjs
node backend/facebook-checks.mjs
node backend/facebook-mention-checks.mjs
node backend/facebook-token-checks.mjs
```

Pruebas locales correctas: 56 casos del simulador, 11 reportados de acceso/guardado, 10 de conexión Instagram, 17 de automatización Instagram, 17 de Facebook, 9 del diagnóstico de menciones y 10 de credenciales duraderas. Proveedores externos simulados: no se utilizaron tokens reales ni se hicieron envíos desde este entorno. Las pruebas de rutas son en proceso. El usuario confirmó el piloto real de comentario y Messenger y mostró la mención visible con `{autor}`. La renovación duradera y su caducidad informada siguen pendientes de validación real en la VM.

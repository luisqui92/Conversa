# Piloto: respuesta al comentario y después DM

Este piloto añade envíos reales a la conexión de Instagram existente. Está separado del simulador y se limita a publicaciones activadas desde la VM. No conecta automáticamente clientes externos ni añade Facebook, TikTok, IA o respuestas de seguimiento a DMs.

## Flujo solicitado

Para comentarios nuevos en el Reel `17968502288460067`:

1. Responder públicamente: **Te mandé info al DM**.
2. Después de que Instagram confirme la respuesta pública, enviar un private reply con: **hola soy yo yo puedo con todo**.

El texto público está redactado en pasado por solicitud del usuario, aunque el DM se intenta después. Si Instagram lo rechaza, la respuesta pública ya puede existir: el sistema conserva ese resultado parcial y lo muestra como error; no afirma internamente que el DM esté confirmado. La aceptación de la API no acredita lectura ni garantiza dónde aparece el mensaje en la interfaz de la otra persona.

## Instalar y activar

En la misma VM, conservando la carpeta y volumen actuales:

```bash
(
set -e
cd ~
curl -fL https://github.com/luisqui92/Conversa/archive/refs/heads/main.zip -o conversa-instagram.zip
unzip -o conversa-instagram.zip -d conversa-instagram-v3
cd ~/conversa-instagram-v3/Conversa-main
sudo bash deploy-vm.sh
sudo docker compose -f compose.vm.yaml exec api node backend/instagram-rule.mjs enable 17968502288460067 "Te mandé info al DM" "hola soy yo yo puedo con todo"
)
```

La última orden ACTIVA la regla; los comentarios nuevos que coincidan pueden producir envíos reales. No solicita otra vez las credenciales. Los datos, reglas, cola y credenciales permanecen en el volumen de la VM. El despliegue puede interrumpir brevemente el servicio. No ejecutar `docker compose down -v`.

La regla usa la cuenta y el propietario que fueron validados y guardados en el asistente de Instagram. Solo procesa eventos firmados de esa cuenta y esa publicación. No aplica filtro de palabras: responderá a cualquier comentario nuevo elegible de otra cuenta. No busca ni procesa retrospectivamente el comentario «Holaaa» ya recibido. Para probar, publicar un comentario nuevo después de activar la regla.

## Consultar el resultado en Conversa

Iniciar sesión y abrir:

`https://cc.chatgo.ia.bo/instagram/`

También aparece el enlace «Instagram: actividad real» junto a la cuenta en la aplicación. La vista muestra reglas, textos, estados y errores del usuario autenticado; se actualiza cada diez segundos y permite actualizar manualmente. La bandeja, campañas y contadores de demostración siguen usando sus propios datos. Los envíos reales no consumen las cuotas ficticias del simulador ni activan cobros.

Desde SSH:

```bash
cd ~/conversa-instagram-v3/Conversa-main
sudo docker compose -f compose.vm.yaml exec api node backend/instagram.mjs status
sudo docker compose -f compose.vm.yaml exec api node backend/instagram-rule.mjs status
```

El primer comando muestra un resumen y los últimos cinco estados; el segundo, las reglas y últimas veinte acciones. No imprimen credenciales. El endpoint privado `/api/integrations/instagram/automation` ofrece el mismo diagnóstico por usuario.

## Pausar

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/instagram-rule.mjs disable 17968502288460067
```

Una solicitud que ya esté en curso puede terminar. El siguiente paso pendiente se cancela al revisar la regla. Para cambiar los textos, ejecutar `enable` con nuevos textos; los pendientes de la versión anterior se cancelan y se conservan sus textos originales para diagnóstico. Repetir `enable` con la misma regla activa no cambia su momento inicial.

## Resultados y prevención de duplicados

| Estado | Significado |
| --- | --- |
| `pending` | Acción guardada; aún no se inició el envío |
| `public_sending` | Solicitud de respuesta pública en curso |
| `public_done` | Instagram devolvió un ID para la respuesta pública; DM pendiente |
| `dm_sending` | Solicitud del DM en curso |
| `sent` | Instagram devolvió ID de respuesta pública e ID de mensaje privado |
| `public_failed` | Instagram rechazó la respuesta pública; no se intentó DM |
| `dm_failed` | Respuesta pública confirmada, DM rechazado |
| `public_unknown` / `dm_unknown` | Resultado incierto por red, interrupción o respuesta sin confirmación |
| `cancelled` / `expired` | Cancelado por pausa/cambio o fuera del plazo del piloto |

Se deduplica por cuenta + ID de comentario, aunque cambie el texto o el sobre del webhook. Cada fase se guarda antes de llamar a Meta y solo se confirma con un identificador válido. Una fase pendiente de confirmación más de 60 segundos pasa a incierta. Los errores y resultados inciertos no se reintentan automáticamente: revisar Instagram antes de una intervención manual. No hay botón de reintento en esta etapa.

Si se reinicia después de confirmar la respuesta pública y antes de iniciar el DM, puede continuar la segunda fase sin repetir la primera. No se promete entrega exactamente una vez ante cortes de red: cuando no se conoce el resultado, se detiene el flujo para evitar reenvíos automáticos.

## Límites del piloto

- Solo comentarios nuevos de `comments`, de la cuenta conectada y las publicaciones activadas; sin respuestas a comentarios propios, a respuestas de otros comentarios ni a Instagram Live.
- Ventana conservadora de diez minutos desde la fecha de la notificación para encolar y procesar. No reproduce históricos; no sustituye los límites que aplique Meta.
- Máximo de treinta flujos de comentario por cuenta y hora. Alcanzado ese límite, se conserva el webhook recibido pero no se encola otro envío.
- Una respuesta pública y un private reply por comentario en este flujo. No continúa conversaciones cuando la persona responde al DM.
- Dependencia de permisos, vigencia del token y restricciones de Meta. Tener la app publicada y recibir comentarios no demuestra que los permisos efectivos permitan los dos envíos.
- Las reglas permanecen en SQLite. Los registros de acciones se depuran siete días después de su última actualización cuando llega otro webhook. El respaldo existente de SQLite incluye las tablas de reglas y acciones; las credenciales siguen en archivo separado.

## API utilizada y verificación

Se utiliza el token existente en Authorization, nunca en la URL:

- Respuesta pública: `POST https://graph.instagram.com/v24.0/{comment-id}/replies`, con `message`.
- Private reply: `POST https://graph.instagram.com/v24.0/{ig-account-id}/messages`, con `recipient.comment_id` y `message.text`.

Referencias de Meta: [Private replies](https://developers.facebook.com/docs/instagram-platform/private-replies/), [Comment moderation](https://developers.facebook.com/docs/instagram-platform/comment-moderation/) y [colección oficial de Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login). Las dos páginas de documentación directa devolvieron HTTP 429 durante esta sesión; se consultó además la colección oficial. La validación final de permisos y compatibilidad requiere probar con la cuenta real en la VM.

```bash
node checks.mjs
node backend/checks.mjs
node backend/instagram-checks.mjs
node backend/instagram-automation-checks.mjs
```

Pruebas locales: 56 casos originales, 11 reportados de acceso/guardado, 10 de conexión y 17 de automatización. Las llamadas externas se simulan; cubren selección por cuenta/publicación, orden, confirmaciones, errores, duplicados, reinicios, pausa, aislamiento y límite por hora. Las pruebas de rutas se ejecutan en proceso. No se ejecutó el piloto con credenciales reales, contenedores ni navegador desde este entorno. El usuario debe instalarlo, activar la regla y verificar el resultado de un comentario nuevo.

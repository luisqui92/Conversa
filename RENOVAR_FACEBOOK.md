> Referencia del piloto anterior. Para la versión multicliente, usa [la guía de operación actual](docs/operacion/multicliente.md).

# Renovar la autorización de Facebook

Conversa amplía primero una autorización nueva de USUARIO mediante
`fb_exchange_token`, obtiene el token de la página elegida con esa autorización
ampliada y consulta su vigencia en Meta. Guarda únicamente el token de PÁGINA,
los metadatos del diagnóstico y las credenciales de app ya utilizadas por el piloto.
Los tokens de usuario de entrada y ampliado solo se utilizan en memoria.

Meta puede informar `expires_at: 0` para un token de página: el diagnóstico no indica
un vencimiento programado. No es una garantía de validez para siempre. Cambios de
autorización, cuenta, permisos o seguridad pueden invalidarlo. El vencimiento del
acceso a datos (`data_access_expires_at`) se muestra por separado.

No hace falta crear otro portafolio ni modificar otras apps. Se utiliza la app
Conversa, ID `39748148371443102`, y la página que ya está configurada en el volumen.
No se intenta prolongar un token que Facebook ya rechaza: se requiere una
autorización nueva del usuario que administra la página.

## Instalar

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

El despliegue puede interrumpir brevemente el servicio. Mantiene el volumen de datos.

## Renovar una conexión existente

1. En el Explorador de Graph, seleccionar **conversa** y generar un token nuevo de
   **USUARIO** con la página LUKMI autorizada y los permisos del piloto:
   `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`,
   `pages_manage_engagement`, `pages_manage_metadata`, `pages_messaging`.
2. No compartir el token en chat, capturas ni parámetros de shell.
3. Ejecutar desde cualquier carpeta de la VM:

```bash
sudo docker exec -it conversa-demo-api-1 node backend/facebook.mjs renew
```

Pegar el token nuevo en el único campo oculto del asistente. La renovación reutiliza
la clave secreta de la app ya guardada. El ID de app se toma de la conexión, de
`FACEBOOK_APP_ID` o del valor por defecto de Conversa; un operador de otra app puede
indicar explícitamente `renew ID_APP`. La clave y el ID deben pertenecer a la misma app.

El comando no publica comentarios ni envía mensajes. Reemplaza la credencial solo
si Meta confirma el tipo PAGE, la app, la identidad de página y la vigencia. Rechaza
tokens que todavía vencen en menos de un día y un diagnóstico sin caducidad informada.
Un error conserva el archivo anterior. Propietario, verificador de webhook y ajustes
existentes se conservan; las reglas y acciones en SQLite no se modifican.

El resultado indica la caducidad real que Meta informó. Solo si aparece **sin
vencimiento programado informado por Meta** se ha observado ese resultado en esta
cuenta. No se promete de antemano que el intercambio vaya a producirlo.

## Comprobar y probar

```bash
sudo docker exec conversa-demo-api-1 node backend/facebook.mjs check-token
sudo docker exec conversa-demo-api-1 node backend/facebook.mjs status
```

`check-token` consulta Meta y actualiza únicamente el diagnóstico privado. No rota
el token y no envía mensajes. Devuelve una salida de error si la autorización ya
requiere reconexión. `status` lee el estado local y las últimas acciones; no hace
una consulta nueva a Meta. Ninguno de los dos imprime tokens ni secretos.

Después de renovar, dejar un comentario nuevo en la publicación que tiene una regla
activa. Los envíos fallidos o inciertos anteriores no se repiten automáticamente.
No es necesario reactivar una regla o volver a configurar el webhook de la misma app.

La página autenticada `/facebook/` muestra el diagnóstico guardado y los rechazos de
autorización detectados en acciones recientes. Avisa de vencimientos conocidos con
siete días de anticipación al consultar la página. No es un monitor externo continuo,
no envía correos y no renueva permisos revocados. La conexión pública de clientes por
OAuth y una supervisión periódica independiente siguen pendientes.

## Transporte y almacenamiento

El intercambio se solicita por POST HTTPS con campos de formulario. Las operaciones
de página usan Authorization. La llamada interna HTTPS al endpoint documentado
`debug_token` incluye el token de página como `input_token` en su consulta; la
credencial de app viaja en Authorization. Esa URL nunca se imprime ni se devuelve
al navegador. Se bloquean redirecciones y se descartan cuerpos de errores externos.

El archivo de credenciales conserva permiso 0600 en el volumen privado. No se afirma
cifrado por la aplicación. Los metadatos que devuelve la API autenticada no contienen
tokens, secretos, verificador, correo del propietario ni datos del usuario de Meta.

## Fuentes y validación

- [Meta: tokens de larga duración](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/).
- [Meta: debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/).
- [Colección oficial de Facebook: obtener tokens de páginas](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api).
- [SDK oficial archivado: intercambio y diagnóstico](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/docs/examples/facebook_login.md).

Las páginas directas de Meta devolvieron 429 desde este entorno; no se presenta el
SDK archivado como garantía de comportamiento actual. Se comprobó que el endpoint
actual acepta los campos de intercambio por POST hasta la validación de cliente,
usando únicamente valores ficticios. No se utilizaron credenciales reales.

```bash
node backend/facebook-token-checks.mjs
node backend/facebook-checks.mjs
```

Las pruebas con proveedor simulado comprueban el orden del intercambio, secretos
omitidos de errores, identidad y caducidad, conservación de archivo ante fallos y
cambios concurrentes, permisos de archivo y avisos sin exponer credenciales. La
renovación real, su vencimiento y el siguiente envío deben validarse en la VM.

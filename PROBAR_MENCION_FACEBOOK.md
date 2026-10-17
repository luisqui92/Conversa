# Prueba de mención al autor de un comentario

Herramienta experimental de CLI, separada de la automatización pública → Messenger.
No modifica reglas ni procesa comentarios históricos automáticamente. `test` publica
una única respuesta pública de prueba en el comentario elegido; no envía un DM.

## Lo observado y lo que falta comprobar

El usuario confirmó que, en sus pruebas de LUKMI, una respuesta manual con mención
notifica y una respuesta manual sin ella no notifica (dos repeticiones). El diagnóstico
de la respuesta automática confirmó el padre correcto, `is_hidden=false` y autoría de
la página. Esto no prueba una regla general para todas las cuentas de Facebook.

Hay referencias de proveedores que describen menciones a participantes del mismo
hilo: [Swat.io, agosto de 2026](https://help.swat.io/en/articles/11841921-mentions-in-comments)
y [NapoleonCat, julio de 2026](https://brain.napoleoncat.com/en/articles/12115719-tagging-people-in-comment-responses).
NapoleonCat también indica que la persona debe seguir la página para obtener un enlace.
Estas referencias describen sus productos, no acreditan que la app Conversa tenga
esa capacidad. La documentación directa de Meta no pudo consultarse por errores de
acceso. Las referencias de menciones a páginas no demuestran soporte para personas.

La prueba ensaya el formato candidato `@[ID_AUTOR]` en `message`, usando exclusivamente
el autor que Graph devuelve para un comentario del piloto. No se presupone que Meta
acepte esa sintaxis para perfiles personales. Un HTTP 200 o ID de respuesta no basta:
se consulta `message_tags` para distinguir una etiqueta reconocida de texto literal.
La notificación se verifica aparte en la cuenta destinataria.

## Ejecutar

Después de actualizar la imagen de API con el código de main:

```bash
cd ~/conversa-instagram-v3/Conversa-main
sudo docker compose -f compose.vm.yaml exec api node backend/facebook-mention.mjs test ID_COMENTARIO
```

Elige un comentario de la cuenta de prueba que ya haya recibido una respuesta del
piloto, en la publicación de LUKMI. No hace falta generar ni pegar nuevos tokens.
`ID_COMENTARIO` es el identificador compuesto del comentario, no el post ni la respuesta.
Si se omite, se elige el comentario con respuesta automática actualizada más recientemente.
Usa un ID explícito para consultar siempre el mismo intento.

Antes del POST se comprueban la identidad del token, la propiedad de la publicación
y el autor. El comentario debe constar en `facebook_actions` para esa página y propietario.
El texto de prueba es `@[ID_AUTOR] Prueba de mención de Conversa.`; si Meta no transforma
el formato, podría quedar visible como texto literal en la respuesta de prueba.

Un archivo privado 0600 bajo `/data/facebook-mention.PAGINA.COMENTARIO.json` se crea
antes del POST. Impide repetir el mismo intento incluso si hay un error, reinicio o
ejecución simultánea. No contiene tokens y no debe eliminarse para forzar reenvíos.

## Interpretar y volver a consultar

- `etiquetaReconocida: true`: `message_tags` incluye al autor consultado.
- `false`: Facebook devolvió etiquetas, pero no una para ese autor.
- `null`: no se devolvió información suficiente; no equivale a éxito ni a fallo.
- `dentroDelComentario` y `oculta` comprueban el hilo y la visibilidad.

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/facebook-mention.mjs inspect ID_COMENTARIO
```

`inspect` solo lee el resultado confirmado y no publica otra respuesta. Si el envío
quedó sin ID, se revisa manualmente en Facebook y se conserva el bloqueo de reenvío.
Si falla la lectura posterior al envío, `inspect` puede volver a consultar sin publicar.

Para validar el resultado real, comprueba que el nombre abre el perfil y si llega la
alerta. Aun con etiqueta reconocida, no se garantiza una notificación. La automatización
habitual no incorporará menciones como una función verificada a partir de mocks.

## Pruebas locales

```bash
node backend/facebook-mention-checks.mjs
```

Comprueban identidad, propiedad y autor, aislamiento, formato de solicitud, lectura de
etiquetas, errores sin secretos y prevención de duplicados concurrentes. El proveedor
es simulado: no demuestran soporte real de etiquetas ni entrega de notificaciones.

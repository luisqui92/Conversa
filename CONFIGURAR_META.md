# Páginas públicas para la configuración de Meta

Las páginas de privacidad, condiciones y eliminación son archivos públicos dentro de `dist/`. No requieren sesión de Conversa. Describen el funcionamiento actual del piloto, no funciones futuras como DMs automáticos, Pixel o suscripciones activas. Se utiliza Lukmi SRL como responsable y el correo de contacto mostrado por el usuario en la configuración de la app: `luisquirogamaita@gmail.com`.

## Instalar en la VM existente

Se conserva la carpeta y el volumen actuales del piloto. No se solicitan otra vez los tokens y no se incluyen credenciales en el repositorio. El despliegue puede interrumpir brevemente el servicio.

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

Abrir las tres páginas antes de registrarlas en Meta, comprobar que se ven sin sesión y revisar que el contacto y la descripción corresponden al servicio:

- `https://cc.chatgo.ia.bo/privacidad/`
- `https://cc.chatgo.ia.bo/terminos/`
- `https://cc.chatgo.ia.bo/eliminar-datos/`

## Configuración de la app nueva Conversa

En Meta Developers → Conversa → Configuración de la app → Básica:

| Campo | Valor |
| --- | --- |
| Dominios de la app | `cc.chatgo.ia.bo` (sin protocolo ni ruta) |
| URL de la política de privacidad | `https://cc.chatgo.ia.bo/privacidad/` |
| URL de Condiciones del servicio | `https://cc.chatgo.ia.bo/terminos/` |
| Eliminación de datos de usuario | Elegir «URL de instrucciones para la eliminación de datos» |
| URL de instrucciones | `https://cc.chatgo.ia.bo/eliminar-datos/` |

Conservar el correo de contacto si es el que se desea atender. Si cambia, actualizar tanto Meta como las tres páginas. El espacio de nombres y otros campos deben completarse solo si Meta los exige o corresponden al uso previsto. La categoría, el icono y otros requisitos que muestre el panel se revisan por separado.

La eliminación publicada se solicita por correo y se atiende manualmente: no existe callback de eliminación ni pantalla de borrado automático. No elegir la modalidad de callback en Meta para esta URL. El operador debe localizar los datos, verificar la solicitud y gestionar también credenciales y respaldos cuando corresponda. La publicación de una página no ejecuta una solicitud de borrado.

Guardar los cambios y volver a Publicar para ver los requisitos restantes. Registrar estas URLs no equivale a publicar la app ni a aprobar los permisos de sus casos de uso. Las otras aplicaciones del usuario, incluida Chatgo, quedan fuera de estos pasos.

## Situación de la prueba de Instagram

El usuario confirmó cuenta profesional y evaluador aceptado. El asistente de la VM validó el token y guardó credenciales; Meta aceptó la verificación del webhook. La suscripción de cuenta está activada y los campos `comments` y `messages` aparecen suscritos en v26.0. El panel informó que la prueba manual de `comments` fue correcta. Tras un comentario nuevo en una publicación antigua, el contador seguía en cero. Esa prueba manual puede llevar un ID ficticio que el receptor descarta; no demuestra recepción de eventos reales.

La app aparece Sin publicar y el panel señaló la URL de privacidad pendiente. Se está resolviendo ese requisito, pero todavía no se comprobó que sea la única causa de la falta de eventos. Después de completar los requisitos y revisar el estado de acceso, hay que repetir la prueba real y comprobar el contador. Los DMs y las respuestas automáticas siguen pendientes.

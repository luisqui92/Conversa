# Actualizar Conversa: acceso y guardado en servidor

## Qué añade

Acceso por correo y contraseña, datos privados por usuario y persistencia SQLite en la VM. El editor y el simulador conservan su funcionamiento, pero sus datos se guardan en el servidor. Las conexiones a Meta/TikTok, IA, cobros y equipos compartidos siguen pendientes.

## Antes de actualizar

Si tienes cambios de la demo en el navegador, exporta una copia JSON desde la aplicación. La nueva interfaz también ofrece importar la copia anterior de ese navegador después de iniciar sesión, siempre mediante una acción explícita tuya.

El despliegue mantiene el proyecto Compose `conversa-demo`, sus certificados y un nuevo volumen de datos. No ejecutes `docker compose down -v`: esa opción eliminaría volúmenes. Cada usuario nuevo comienza con los ejemplos ficticios del prototipo.

## Descargar la versión nueva

Desde SSH en la misma VM, con Docker ya instalado:

```bash
cd ~
curl -fL https://github.com/luisqui92/Conversa/archive/refs/heads/main.zip -o conversa-backend.zip
unzip -o conversa-backend.zip -d conversa-backend-v2
cd ~/conversa-backend-v2/Conversa-main
sudo bash deploy-vm.sh
```

Se usa una carpeta nueva para preparar el código antes de recrear los servicios. El script construye la imagen de la API, valida Caddy y recrea los contenedores. La API no tiene puertos publicados y SQLite queda fuera de los archivos web. Puede haber una interrupción breve durante la actualización. La imagen Node 24 puede ocupar varios cientos de MB; revisar espacio disponible si falla la construcción.

En actualizaciones posteriores de esta misma etapa puedes repetir estos pasos. Los datos no viven en el ZIP ni en la carpeta de código: permanecen en el volumen de Docker. Este procedimiento no es un despliegue sin interrupciones ni implementa reversión automática.

## Crear tu acceso

En esa carpeta, ejecutar una sola vez por usuario:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/admin.mjs create-user
```

Escribir correo y una contraseña de al menos 12 caracteres, y repetirla cuando lo pida. No se muestran los caracteres de la contraseña. Si el usuario ya existe, el comando lo indica sin reemplazarlo.

Abrir `https://cc.chatgo.ia.bo`, iniciar sesión y comprobar el indicador «Guardado en servidor». No escribir contraseñas en comandos, capturas o mensajes del chat.

## Verificar después

```bash
sudo docker compose -f compose.vm.yaml ps
sudo docker compose -f compose.vm.yaml logs --tail=60 api web
curl -fsS https://cc.chatgo.ia.bo/api/health
```

La última llamada debe devolver `{"ok":true}`. No muestra datos privados. Probar que una visita anónima pide iniciar sesión; crear una campaña, recargar y comprobar su persistencia. Abrir una segunda cuenta con otro navegador para verificar que no ve los cambios de la primera.

No se ejecutaron estos comandos contra la VM desde el chat: no hay sesión SSH conectada aquí. Las comprobaciones de contenedores, tráfico real y navegador requieren completar esta actualización en la VM.

## Importar los datos anteriores

Si el mismo navegador conserva `conversa-demo-v2`, aparecerá «Importar datos anteriores del navegador». La confirmación muestra qué espacios se copiarán y el correo de la cuenta receptora. Reemplaza los datos de esa cuenta y conserva la copia local original. También se puede restaurar una exportación JSON mediante la función existente de la aplicación.

La copia de un navegador no se comparte automáticamente con cuentas nuevas. Revisar el indicador de guardado antes de cerrar la pestaña.

## Cambiar una contraseña

Desde la VM:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/admin.mjs set-password
```

Pide el correo y la nueva contraseña. Invalida todas las sesiones anteriores de ese usuario. No hay recuperación automática por correo en esta etapa.

## Copias de seguridad

Crear una copia consistente de SQLite mientras la API está funcionando:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/backup.mjs
```

El comando muestra una ruta `/data/backups/...sqlite`. Para extraer una copia fuera del volumen, sustituir la ruta por la que acaba de devolver:

```bash
sudo docker compose -f compose.vm.yaml cp api:/data/backups/NOMBRE_REAL.sqlite ./conversa-respaldo.sqlite
```

Guardar ese archivo en una ubicación privada separada de la VM. Contiene datos de usuarios y hashes de credenciales; no publicarlo en GitHub. Los respaldos guardados solo en el mismo disco no protegen frente a perder la VM. No hay calendario automático de respaldos ni procedimiento de restauración automatizado todavía.

## Conflictos o desconexiones

Si otra pestaña guardó una versión más nueva, la aplicación detiene el guardado de la pestaña antigua y pide exportar y recargar. No fuerza una sobrescritura. Si falla la conexión conserva los cambios en memoria, muestra el error y permite reintentar; exportar una copia antes de cerrar. No promete guardado sin conexión.

## Próxima conexión de Instagram

Esta actualización no pide ni guarda credenciales de Meta. El siguiente paso es comprobar que existe una aplicación de Meta administrada por el usuario y una cuenta profesional de Instagram autorizable. Instagram Login permite una ruta sin página de Facebook vinculada, pero sigue sujeto a los permisos y revisiones de Meta. Los activos del portafolio afectado no se recuperan ni cambian de propietario al instalar este backend.

# Operación multicliente de Conversa

Esta versión usa una sola instalación para varios negocios. Cada negocio tiene un propietario con acceso privado y puede autorizar varias cuentas profesionales de Instagram y páginas de Facebook. Los colaboradores de un mismo negocio, contratación automática, TikTok, IA y respuestas manuales a conversaciones entrantes siguen fuera del alcance actual.

## Actualizar la instalación existente

1. Descarga la versión publicada en una carpeta nueva, conservando la carpeta anterior hasta comprobar el servicio. No copies secretos a la nueva carpeta: viven en volúmenes Docker.
2. En la nueva carpeta ejecuta `sudo bash deploy-vm.sh`.
3. El script conserva el proyecto `conversa-demo`; construye la imagen y valida Caddy antes de detener la API. Luego guarda una copia SQLite consistente, genera o reutiliza la llave y migra las conexiones y colas existentes. Solo elimina los antiguos archivos de credenciales tras comprobar que las conexiones cifradas se pueden leer. Las reglas y los identificadores de envíos no se reinician.
4. Si la migración falla, el inicializador restaura la base y los archivos anteriores y el script intenta iniciar el contenedor anterior. No continúes ignorando el error.
5. La API inicia con la llave montada como solo lectura. Comprueba `https://cc.chatgo.ia.bo/api/health`, inicia sesión y revisa **Canales**, **Automatizaciones**, **Actividad** y **Clientes**. Prueba un comentario nuevo en una publicación configurada y comprueba el comentario público, el DM y la campana de Conversa.

Volúmenes que deben conservarse:

| Volumen | Contenido |
| --- | --- |
| `conversa-demo_conversa_data` | SQLite, diagnósticos y copias locales de migración |
| `conversa-demo_conversa_keys` | Llave maestra de cifrado de 32 bytes |
| `conversa-demo_caddy_data` | Certificados HTTPS |
| `conversa-demo_caddy_config` | Estado de Caddy |

Nunca ejecutar `down -v`. Si desaparece la llave, la base cifrada no permite recuperar los tokens. La inicialización se niega a sustituir una llave ausente cuando ya hay credenciales cifradas.

El propietario único de las conexiones anteriores recibe automáticamente el rol administrador. Si no aparece **Clientes**, un operador autorizado puede ejecutar:

```bash
sudo docker exec conversa-demo-api-1 node backend/accounts.mjs grant-admin TU_CORREO
```

Cierra sesión y entra otra vez. En instalaciones nuevas, crea el primer acceso con `sudo docker exec -it conversa-demo-api-1 node backend/admin.mjs create-user` y asígnale el rol anterior. No hay usuarios ni contraseñas predeterminados.

## Configurar Meta una vez

La aplicación de Facebook es **Conversa**, ID `39748148371443102`. La aplicación de Instagram del piloto es `1797199674816532`. No modificar la aplicación separada Chatgo.

La importación reutiliza las claves y verificadores existentes. Conserva los webhooks actuales:

- Instagram: `https://cc.chatgo.ia.bo/api/webhooks/instagram`
- Facebook/Page: `https://cc.chatgo.ia.bo/api/webhooks/facebook`

Registra las siguientes URL exactas de retorno en las opciones correspondientes de autorización de Meta:

- Instagram, configuración del inicio de sesión de empresa de Instagram: `https://cc.chatgo.ia.bo/api/oauth/instagram/callback`
- Facebook Login / Facebook Login for Business, URI de redirección OAuth válida: `https://cc.chatgo.ia.bo/api/oauth/facebook/callback`

Para Facebook Login for Business, crea una configuración que conceda los permisos de páginas necesarios. Si Meta requiere un ID de configuración, introdúcelo en el asistente siguiente; su disponibilidad y tipo dependen del modo de acceso autorizado por Meta.

Si falta la configuración de una aplicación o se rota su secreto, el operador puede ejecutar estos asistentes. Las claves se introducen ocultas y no se ponen en argumentos ni en el navegador:

```bash
sudo docker exec -it conversa-demo-api-1 node backend/accounts.mjs configure-app instagram 1797199674816532
sudo docker exec -it conversa-demo-api-1 node backend/accounts.mjs configure-app facebook 39748148371443102
```

Conservan el verificador de un webhook ya configurado. Al rotar el secreto, actualizan también las conexiones vinculadas a esa aplicación. El ID de configuración de Facebook es opcional en el asistente; úsalo cuando corresponda a tu configuración de Meta.

Permisos utilizados:

- Instagram: `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`.
- Facebook: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `pages_messaging`.
- Campos del webhook: Instagram `comments` y `messages`; Page `feed`, `messages`, y `messaging_postbacks` para la suscripción de la página.

Publicar la aplicación no concede automáticamente acceso avanzado. Para clientes ajenos a los roles de prueba, completa la verificación empresarial, revisión de aplicación y acceso avanzado que Meta exija para esos permisos. Esta publicación de código no acredita esas aprobaciones. Prueba primero con cuentas autorizadas de la aplicación.

## Incorporar un cliente

1. Administrador: **Clientes → Crear cliente**, introduce nombre comercial y correo. Copia el enlace de invitación y compártelo en privado. No se envía un correo automáticamente. El enlace caduca a las 24 horas y solo sirve una vez; no queda guardado como texto en el servidor. Si se pierde o vence, usa **Renovar invitación** mientras el acceso siga pendiente; el anterior deja de servir.
2. Cliente: abre el enlace y elige su propia contraseña de 12 a 256 caracteres. Después inicia sesión y abre **Canales → Conectar Instagram / Conectar Facebook**. El administrador no elige ni recibe esa contraseña. Los accesos existentes conservan sus credenciales; renovar una invitación no permite cambiar un acceso ya activado.
3. Autoriza los permisos en la página oficial de Meta. Conversa nunca pide la contraseña de Facebook o Instagram.
4. En Facebook, vuelve al panel y selecciona expresamente la página autorizada. Las demás páginas no se conectan automáticamente. La selección caduca a los diez minutos.
5. En **Automatizaciones**, selecciona la cuenta y publicación; configura comentario público, DM, palabras clave y tiempo mínimo entre respuestas a la misma persona en esa publicación.
6. Haz una prueba nueva y revisa resultados y notificaciones en ese mismo acceso.

Una cuenta social ya conectada a otro negocio no se reasigna automáticamente. Para una transferencia, el operador debe verificar la titularidad y preparar una migración de datos; el panel rechaza esa operación.

## Qué significa un resultado

- **Enviado**: Meta devolvió identificadores de aceptación para el comentario y el DM. No acredita lectura, bandeja principal o notificación en Facebook.
- **Omitido por persona**: ya existía una acción para esa persona/publicación dentro de la pausa configurada. No se envía otro DM.
- **Omitido por palabra clave**: el comentario no coincide con los filtros de la regla.
- **Omitido por antigüedad**: el evento tiene más de diez minutos; se registra sin enviar.
- **Omitido por límite**: ya se admitieron 30 automatizaciones en la última hora para esa cuenta. Se registra y avisa; no hay envío diferido ni reintento automático.
- **Fallido**: Meta rechazó explícitamente la operación. Corrige la causa; las acciones anteriores no se repiten automáticamente.
- **Resultado incierto**: hubo un corte sin confirmación durante un envío. Antes de actuar, comprueba en la red social si existe el comentario o DM. No cambies el estado ni reenvíes a ciegas. Conserva cuenta, comentario e identificadores para soporte; solo decidir un reintento tras esa comprobación.

La pausa nueva del panel es de 24 horas y se aplica por cuenta, persona y publicación. `0` la desactiva. El mismo comentario no se procesa dos veces aunque Meta repita el webhook. Los mensajes públicos se envían primero; si fallan, no se afirma que se haya enviado el DM.

## Vigencia y mantenimiento

Instagram intenta renovar tokens largos válidos antes del vencimiento, aproximadamente a los 45 días, y registra el nuevo vencimiento. Los tokens legados sin fecha se intentan refrescar después de un día desde su comprobación. Si eran tokens cortos, vencieron o Meta revocó permisos, la renovación puede fallar: usa **Canales → Reconectar**. No se promete un token permanente.

Facebook comprueba el token de página diariamente. Puede no tener vencimiento programado y aun así perder acceso por cambios en la cuenta, permisos o autorización de datos. La recuperación exige nueva autorización del cliente desde Canales.

El endpoint `/api/health` comprueba actividad reciente de los workers además de la API. El administrador ve su estado en Clientes. No hay monitor externo ni alertas fuera del panel configuradas: conecta ese endpoint a un monitor independiente antes de prometer disponibilidad.

Diagnóstico administrativo, sin mostrar secretos:

```bash
sudo docker exec conversa-demo-api-1 node backend/accounts.mjs list
sudo docker logs --tail=80 conversa-demo-api-1
```

Si usas comandos de diagnóstico antiguos y hay varias cuentas del mismo canal, selecciona explícitamente el UUID devuelto por `accounts.mjs list`:

```bash
sudo docker exec -e CONVERSA_ACCOUNT_ID=UUID_DE_LA_CUENTA conversa-demo-api-1 node backend/facebook.mjs status
```

No publicar salidas de archivos privados ni copiar tokens al chat o GitHub.

## Conservación y respaldos

El procedimiento actualizado está en [respaldos externos y recuperación](respaldos.md): base en bucket privado, llave en Secret Manager con permisos separados y comprobación de restauración. No se activa automáticamente al desplegar.

Acciones: 90 días; la API devuelve las últimas 50 del periodo seleccionado y sus agregados. Eventos de diagnóstico: siete días con límite de 2.000 por usuario/canal. Avisos del panel: siete días. Las limpiezas se realizan al recibir/consultar datos, no por una tarea de borrado independiente. No existe histórico ilimitado ni medición de conversiones comerciales.

La migración y `backend/backup.mjs` crean **copias locales**, útiles para un error de actualización pero insuficientes ante pérdida del disco. Antes de incorporar datos comerciales, configura y comprueba una copia fuera de la VM que incluya **datos y llave**. Por ejemplo, una política de snapshots del disco de Google Cloud con acceso restringido, retención definida y prueba de restauración en otra VM; el disco debe incluir ambos volúmenes. Esa política no se crea ni se da por activa con este despliegue.

Para una copia manual coherente de SQLite mientras la aplicación funciona:

```bash
sudo docker exec conversa-demo-api-1 node backend/backup.mjs
```

El archivo indicado queda en `/data/backups`. Un respaldo de SQLite por sí solo no incluye la llave, certificados ni archivos auxiliares. Exporta y protege la llave separadamente bajo control administrativo; no la expongas en la web ni en GitHub. Las copias previas no se borran automáticamente: define retención y revisa eliminación de datos también en respaldos.

## Recuperación de una migración

Si falla la inicialización, la reversión es automática. Si el servicio falla después de completar una migración, no inicies sin más la versión antigua: las tablas anteriores son vistas de lectura en la nueva base.

Procedimiento del operador, con interrupción del servicio:

1. Conserva los volúmenes y la llave. Detén la API con `sudo docker compose -f compose.vm.yaml stop -t 60 api` desde la carpeta nueva.
2. Lista nombres de copias sin mostrar contenido privado:

   ```bash
   sudo docker compose -f compose.vm.yaml run --rm --no-deps init sh -c 'ls -1 /data/migration-backups/*.sqlite'
   ```

3. Elige el respaldo `before-multiclient-TIMESTAMP.sqlite` correspondiente a la actualización. Restaurarlo retira del servicio los cambios posteriores a esa copia; el asistente conserva primero la base actual en `before-restore-*.sqlite`.

   ```bash
   sudo docker compose -f compose.vm.yaml run --rm --no-deps -e CONVERSA_RESTORE_OFFLINE=1 init node backend/restore-migration.mjs before-multiclient-TIMESTAMP.sqlite
   ```

4. El asistente verifica llave, paquete de recuperación e integridad antes de sustituir datos. Recupera también los archivos de credenciales anteriores cuando existían. Conserva todos los respaldos.
5. Inicia el código compatible con esa copia desde la carpeta anterior. No ejecutes el script nuevo si tu intención es volver a la versión anterior, porque migraría de nuevo.
6. Comprueba salud, login, cuentas, reglas y acciones. No reenvíes acciones inciertas automáticamente.

La restauración se prueba con datos temporales; cada respaldo real necesita su propia prueba de recuperación. No ejecutar el asistente con la API activa.

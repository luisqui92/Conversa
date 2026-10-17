# Conversa

Plataforma en desarrollo de ChatGo / Lukmi SRL para campañas por publicación y seguimiento de prospectos, con foco en inmobiliarias de Bolivia.

## Estado actual

- Acceso por correo y contraseña, con usuarios creados desde la VM.
- Sesiones de 12 horas con cookie Secure, HttpOnly y SameSite=Strict.
- Campañas, conversaciones simuladas y prospectos guardados en SQLite en servidor, separados por usuario.
- Control de versiones para evitar que una pestaña antigua sobrescriba cambios nuevos.
- Importación opcional de la demo anterior del navegador, conservando su copia original.
- Cada usuario tiene datos privados propios; equipos compartiendo una empresa y administración web de usuarios siguen pendientes.

Se incluye un receptor de webhooks de Instagram y un asistente de configuración desde la VM para una cuenta profesional de prueba: [CONECTAR_INSTAGRAM.md](CONECTAR_INSTAGRAM.md). Requiere instalar esta versión, introducir credenciales y configurar Meta. No conecta automáticamente las cuentas.

**Los comentarios y DMs de la interfaz siguen siendo simulados.** El receptor registra eventos firmados. Un piloto separado puede responder primero al comentario y luego enviar un DM al activar una regla para una publicación desde la VM. No sincroniza estos resultados con la bandeja de demostración. Ver [AUTOMATIZAR_INSTAGRAM.md](AUTOMATIZAR_INSTAGRAM.md) y `/instagram/` para su activación y seguimiento. También se incluye una conexión piloto de página de Facebook y Messenger, con credenciales y reglas separadas: [CONECTAR_FACEBOOK.md](CONECTAR_FACEBOOK.md). Todavía no hay IA conectada, OAuth para clientes, Pixel activo ni cobros. Los planes y cuotas continúan siendo de prueba.

## Actualizar la VM de Google Cloud

El usuario ya instaló y comprobó Docker Engine y Compose en Ubuntu 24.04 x86_64. El despliegue conserva el nombre de proyecto Compose `conversa-demo` para reutilizar los volúmenes de certificados y datos al cambiar de carpeta.

Consulta [ACTUALIZAR_BACKEND.md](ACTUALIZAR_BACKEND.md). La nueva versión agrega la API interna y un volumen de SQLite. No publica el puerto de la API a internet: Caddy sirve HTTPS y deriva `/api/*` al servicio interno.

Las páginas públicas de [privacidad](dist/privacidad/index.html), [condiciones](dist/terminos/index.html) y [eliminación de datos](dist/eliminar-datos/index.html) se sirven sin sesión. Consulta [CONFIGURAR_META.md](CONFIGURAR_META.md) para instalarlas y registrar sus URLs en la app nueva de Meta. La eliminación se solicita por correo y requiere gestión manual del operador.

Una vez levantado el servicio, crear el primer usuario dentro de la VM:

```bash
sudo docker compose -f compose.vm.yaml exec api node backend/admin.mjs create-user
```

Solicita el correo y la contraseña dos veces. La contraseña se introduce oculta y requiere al menos 10 caracteres. No hay contraseña predeterminada ni registro público. No se requieren credenciales de Meta para esta etapa.

## Comprobar

Requiere Node 24 o superior, con `node:sqlite`:

```bash
node checks.mjs
node backend/checks.mjs
node backend/instagram-checks.mjs
node backend/instagram-automation-checks.mjs
node backend/facebook-checks.mjs
```

Pasan los 56 casos originales y las nuevas pruebas de autenticación, aislamiento, expiración, límites de acceso, persistencia, conflictos de guardado y cola de cambios del navegador. Las pruebas de rutas se ejecutan en proceso, sin sockets. No se verificó el contenedor ni la interfaz en un navegador desde este entorno.

## Archivos principales

- `dist/`: interfaz, simulador y cliente de sesión/guardado.
- `backend/`: servidor HTTP, base SQLite, administración local y copia de seguridad.
- `compose.vm.yaml`, `Caddyfile.vm`, `deploy-vm.sh`: despliegue en Google Cloud VM.
- `ACTUALIZAR_BACKEND.md`: actualización, creación de usuarios y operación.
- `CONECTAR_INSTAGRAM.md`: credenciales privadas y primer receptor de eventos de Instagram.
- `CONFIGURAR_META.md`: páginas públicas y campos de configuración básica de Meta.
- `AUTOMATIZAR_INSTAGRAM.md`: regla piloto por publicación, orden público → DM, pausa y diagnóstico.
- `CONECTAR_FACEBOOK.md`: token de página, webhook de Page y flujo de comentario a Messenger.
- `RENOVAR_FACEBOOK.md`: intercambio para obtener una autorización duradera y comprobación de vigencia.
- `PUBLICAR_GOOGLE.md`: guía de la publicación inicial estática; para esta versión usar la guía de actualización.
- `package.py`: genera una demo autónoma que sigue usando guardado local.

## Modo local y datos

`dist/index.html` usa el backend por defecto y no vuelve silenciosamente a guardar en el navegador si la API falla. Con `python3 package.py` se genera `conversa-demo.html` con modo local explícito para demostraciones sin servidor.

En servidor, SQLite vive en el volumen `conversa-demo_conversa_data`. No guardar bases de datos, contraseñas, tokens ni respaldos en GitHub. La cuenta de la app se administra desde la VM; recuperar activos de Meta y obtener permisos de su API son procesos distintos.

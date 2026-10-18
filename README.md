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

**El panel principal muestra actividad real de Instagram y Facebook.** Resumen, Actividad, Automatizaciones y Canales consultan las conexiones existentes del propietario. Permite editar los mensajes por publicación y pausar o reactivar reglas desde la web, con control de versiones. La campana guarda los resultados de cada automatización y los avisos pendientes de lectura, con actualización cada cinco segundos mientras el panel está visible. La demo anterior se conserva en **Explorar demo**, con sus datos de ejemplo. Consulta [PANEL_REAL.md](PANEL_REAL.md) para instalarlo y conocer sus límites.

El flujo real responde primero al comentario y luego solicita un DM. Los resultados indican aceptación por la API, no lectura ni notificación. La vinculación inicial y renovación de credenciales siguen siendo administrativas; la respuesta manual a mensajes entrantes, IA, OAuth para clientes, Pixel y cobros siguen pendientes. Ver [AUTOMATIZAR_INSTAGRAM.md](AUTOMATIZAR_INSTAGRAM.md), [CONECTAR_FACEBOOK.md](CONECTAR_FACEBOOK.md) y [RENOVAR_FACEBOOK.md](RENOVAR_FACEBOOK.md).

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
node backend/panel-checks.mjs
node backend/notification-checks.mjs
```

Pasan los 56 casos originales y las nuevas pruebas de autenticación, aislamiento, expiración, límites de acceso, persistencia, conflictos de guardado y cola de cambios del navegador. Las pruebas de rutas se ejecutan en proceso, sin sockets. El panel se comprobó en Chromium de escritorio y móvil con datos temporales, incluidos los cambios de reglas mediante la API real. El contenedor se construyó y pasó las pruebas del panel y su endpoint de salud. La instalación actualizada en la VM requiere comprobación después del despliegue.

## Archivos principales

- `dist/`: panel real, simulador y cliente de sesión/guardado.
- `PANEL_REAL.md`: instalación y uso de Resumen, Actividad, Automatizaciones y Canales.
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

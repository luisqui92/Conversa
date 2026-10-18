# Conversa

Plataforma en desarrollo de Lukmi SRL para responder comentarios y enviar información por Instagram o Messenger. La versión multicliente permite crear negocios desde el panel, mantener sus cuentas separadas y conectar varias cuentas sociales por negocio en una misma instalación.

## Funciones disponibles

- Acceso privado por correo y contraseña. El administrador crea clientes en **Clientes** y comparte una invitación privada de un solo uso; el cliente elige su contraseña y entra a su propio espacio. Un acceso propietario por negocio; los equipos con varios colaboradores aún no están implementados.
- Conexión y reconexión mediante la autorización oficial de Meta desde **Canales**, con selección explícita de la página de Facebook.
- Webhooks y workers que procesan varias cuentas sin mezclar credenciales, reglas, actividad ni notificaciones.
- Reglas por publicación: respuesta pública primero y mensaje privado después. Filtros por palabras clave y pausa por persona/publicación, inicialmente 24 horas en las reglas nuevas del panel.
- Estados explícitos para comentarios omitidos por antigüedad, límite o repetición. Avisos persistentes al completar el flujo, fallar o quedar incierto; campana actualizada cada cinco segundos mientras el panel está visible.
- Actividad de 7, 30 o 90 días; datos de acciones conservados 90 días y eventos de diagnóstico siete días. No equivale a medir ventas o conversiones.
- Tokens cifrados con AES-256-GCM y una llave fuera del volumen de SQLite. Renovación periódica de tokens largos válidos de Instagram y comprobación diaria de Facebook. Meta puede revocar autorizaciones; Facebook permite reconectar desde Canales.

El código de autorización está implementado, pero **atender clientes externos requiere que Meta apruebe los permisos y que se registren las URLs de retorno**. La campana de Facebook, la llegada a la bandeja principal y la lectura del DM dependen de Meta. Una respuesta aceptada por su API no garantiza esos resultados.

## Instalar o actualizar

Usa la [guía multicliente](docs/operacion/multicliente.md). El script `sudo bash deploy-vm.sh` conserva el proyecto Compose `conversa-demo` y su volumen de datos, detiene el worker antes de migrar y guarda un respaldo previo. Importa las conexiones piloto existentes sin volver a introducir sus tokens.

La copia de migración permanece en el mismo disco: **el respaldo fuera de la VM y la monitorización externa siguen pendientes de configuración**. El panel muestra esa limitación al administrador. Sigue el [procedimiento de respaldo externo y restauración](docs/operacion/respaldos.md): bucket para SQLite y Secret Manager para la llave, con permisos separados.

Las guías antiguas de conexión por SSH se mantienen como referencia de diagnóstico del piloto. La guía multicliente es la referencia para esta versión. No ejecutar `docker compose down -v` ni borrar los volúmenes.

## Desarrollo y comprobación

Requiere Node **24**, Docker para las verificaciones de contenedor y npm para las herramientas de desarrollo. La aplicación no instala dependencias de ejecución.

```bash
npm ci --ignore-scripts
npm run lint
npm run format:check
npm test
docker build -f backend/Dockerfile -t conversa-check .
```

GitHub Actions ejecuta esos controles en cada push a `main` y en pull requests. Las pruebas cubren separación de clientes, cifrado, migración y restauración, estados OAuth de un solo uso, sesiones, colas, notificaciones, políticas de automatización y renovación. Los contratos de Meta se prueban con respuestas simuladas; las autorizaciones reales se verifican después de configurar la aplicación en Meta.

El panel también se comprobó con Chromium en escritorio y móvil, creando un cliente, editando reglas, revisando el aislamiento de su actividad e iniciando la autorización. La imagen Docker se comprobó con datos temporales: migración de dos conexiones, inicio, salud, login y acceso administrativo.

## Organización

- `dist/`: panel real y demo de datos de ejemplo, claramente separada.
- `backend/channel-accounts.mjs`: negocios y almacén cifrado de conexiones.
- `backend/oauth.mjs`: autorización con Meta y selección de páginas.
- `backend/comment-automation-store.mjs`: cola común con canal y cuenta explícitos.
- `backend/credential-maintenance.mjs`: mantenimiento de autorizaciones.
- `backend/initialize.mjs`: respaldo e importación de la instalación anterior.
- `docs/operacion/multicliente.md`: instalación, permisos, respaldo y recuperación.
- `compose.vm.yaml`, `Caddyfile.vm`, `deploy-vm.sh`: publicación en la VM.
- `package.py`: genera una demo autónoma con almacenamiento local para presentaciones.

Las páginas públicas de [privacidad](dist/privacidad/index.html), [condiciones](dist/terminos/index.html) y [eliminación de datos](dist/eliminar-datos/index.html) no requieren sesión. No guardar bases, llaves, tokens, contraseñas ni respaldos en GitHub.

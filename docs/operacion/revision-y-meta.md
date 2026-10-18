# Revisión de cambios y autorización de Meta

## Flujo de cambios

Usar una rama y un PR por problema concreto: por ejemplo, enrutamiento de webhooks, invitaciones o respaldo. Evitar mezclar refactorizaciones generales o reformatear todo el repositorio con una función nueva. La descripción debe explicar un caso antes/después, pruebas realizadas y límites pendientes. Revisar el diff y esperar CI verde antes de fusionar. No desplegar una rama pendiente de revisión sobre los datos de clientes.

El PR de respaldo se apoya en el de invitaciones para conservar ambos cambios en el panel y el servidor. Fusionar primero invitaciones, retargetear respaldo a `main` y exigir CI verde nuevamente. El PR de webhooks se puede revisar por separado; la documentación se incorpora después del respaldo. Se probaron juntos localmente antes de publicar. Los ejemplos con datos sintéticos no acreditan permisos ni funcionamiento real de Meta o Google Cloud.

La ejecución de GitHub Actions por sí sola no impide un push directo a `main`. Un administrador de GitHub debe configurar **Settings → Rules → Rulesets**, o la protección de ramas si esa es la opción disponible:

1. Aplicar la regla a `main` y poner su ejecución en activa.
2. Exigir pull request antes de fusionar.
3. Exigir la comprobación **node**, del workflow **Checks**, y que la rama esté actualizada con `main` antes de fusionar.
4. Impedir force pushes y eliminación de la rama; revisar las excepciones de bypass.
5. Exigir una aprobación si hay un segundo revisor disponible. El autor no puede aprobar su propio PR; no configurar una regla que impida toda revisión disponible sin acordar quién revisa.

Esta integración recibió `403 Resource not accessible by integration` al consultar la protección de `main`; no puede activar ni certificar esa configuración. El propietario debe comprobarla en GitHub. No afirmar que CI es obligatorio hasta que la regla esté activa.

## Meta: requisito para clientes externos

La aprobación de Meta no puede obtenerse con una migración ni un token nuevo. Mientras no se compruebe el acceso requerido para terceros, limitar las pruebas a las cuentas y roles autorizados por Meta y no prometer conexión pública de cualquier negocio.

La aplicación que se está configurando es **Conversa**, Facebook ID `39748148371443102`, y su integración de Instagram `1797199674816532`. No modificar la aplicación separada Chatgo.

| Función | Permisos solicitados actualmente | Evidencia de revisión |
| --- | --- | --- |
| Elegir página de Facebook | `pages_show_list` | Autorizar, seleccionar página y verla en Canales |
| Leer publicación/comentario y responder | `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement` | Comentario nuevo y respuesta pública dentro de ese comentario |
| Suscribir eventos de página | `pages_manage_metadata` | Cuenta suscrita y evento firmado registrado |
| Mensaje privado de Facebook | `pages_messaging` | Mensaje aceptado para la interacción permitida por Meta |
| Identificar cuenta profesional de Instagram | `instagram_business_basic` | Autorización y cuenta correcta en Canales |
| Responder comentarios de Instagram | `instagram_business_manage_comments` | Regla por publicación y respuesta a un comentario nuevo |
| Mensaje privado de Instagram | `instagram_business_manage_messages` | DM autorizado según las restricciones de Meta |

Solicitar solo los permisos utilizados. Si se retira una función, retirar su scope y adaptar el código en el mismo PR. La tabla describe las solicitudes del código; no acredita que Meta las haya aprobado.

Preparar el expediente:

1. Revisar en el panel de Meta el acceso efectivo de cada permiso, la verificación empresarial y los requisitos que indique para el tipo de app. Guardar evidencia de esos estados.
2. Registrar las URLs de retorno y conservar los webhooks conforme a la guía multicliente. Comprobar que privacidad, condiciones y eliminación de datos sean accesibles sin sesión y describan el comportamiento actual.
3. Crear un negocio y cuenta de prueba separados de clientes reales. Preparar acceso para el revisor según las instrucciones de Meta; no publicar contraseñas ni tokens en GitHub o en estas guías.
4. Grabar el recorrido real de autorización, selección de cuenta, creación de regla, comentario nuevo, respuesta pública y DM. Mostrar además el resultado de la automatización y la campana de Conversa.
5. Explicar para cada permiso la función que lo necesita y los pasos reproducibles de la grabación. No presentar datos simulados como envíos reales.
6. Enviar la revisión desde Meta y atender sus observaciones. Registrar aprobación o rechazo por permiso; publicar la app no sustituye el acceso avanzado requerido.
7. Solo tras la aprobación pertinente, probar el flujo con un negocio ajeno a los roles de la app y obtener evidencia de la conexión, eventos y envíos. Mantener un procedimiento de desconexión y solicitud de eliminación.

La campana de Facebook, lectura del DM, llegada a Solicitudes o bandeja principal no se controlan desde Conversa. Separar esas observaciones de la aceptación por la API. TikTok, IA, Pixel y contratación automática siguen pendientes.

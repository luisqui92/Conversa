# Respaldos externos y prueba de recuperación

El código prepara copias coherentes de SQLite y una comprobación aislada de recuperación. **Crear un PR o desplegarlo no configura Google Cloud**. Esta instalación no tiene por defecto un bucket, una versión de la llave en Secret Manager ni un timer activo. No dar el procedimiento por terminado hasta recuperar una copia real desde ambos servicios.

## Destinos e identidades

| Recurso | Contenido | Permiso del proceso diario | Recuperación |
| --- | --- | --- | --- |
| Bucket privado externo a la VM | SQLite y manifiesto con SHA-256 | Crear objetos nuevos | Identidad de recuperación puede leer objetos |
| Secret Manager | Llave maestra, versión numérica inmutable | Ningún permiso de lectura | Identidad de recuperación autorizada para esa llave |
| VM, volumen de llaves | Llave necesaria para operar la aplicación | La aplicación la lee localmente | Reponer desde Secret Manager al recuperar |

La copia del bucket no contiene la llave ni los antiguos archivos JSON de credenciales. Los tokens siguen cifrados; los demás datos personales de SQLite dependen de la protección de acceso y cifrado de Google Cloud. El manifiesto guarda una huella SHA-256 de la llave y el identificador de su versión, no la llave. Conserva cada versión mientras exista algún respaldo que la necesite. No usar `latest`: una rotación no debe cambiar qué llave corresponde a una copia anterior.

Separar servicios no basta si todo el mundo tiene permisos sobre ambos. La cuenta de la tarea diaria no debe tener `secretAccessor`, roles amplios heredados como Editor/Owner ni lectura de objetos de respaldo. Una identidad de recuperación necesita reunir temporalmente los dos accesos. La VM en ejecución conserva necesariamente acceso a su llave local: esta separación protege los respaldos; no protege frente a un administrador que controle la VM completa.

## Preparación por el administrador de Google Cloud

Ejecutar en Cloud Shell con una identidad administrativa. Los comandos crean recursos con coste; revisa nombres, ubicación, retención e IAM para el proyecto real. No se han ejecutado desde este entorno.

```bash
gcloud config set project conversa-app-511802
gcloud services enable storage.googleapis.com secretmanager.googleapis.com
```

Elige un nombre de bucket disponible globalmente. Ejemplo, si está libre:

```bash
conversa_backup_bucket=conversa-app-511802-backups
gcloud storage buckets create "gs://$conversa_backup_bucket" \
  --location=us-central1 --uniform-bucket-level-access --public-access-prevention
```

Define una retención de 30 días mediante ciclo de vida (no es un bloqueo irreversible). El bucket debe estar fuera del disco de la VM. Puedes usar otro proyecto bajo control de una identidad de recuperación independiente.

```bash
cat > /tmp/conversa-backup-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}
JSON
gcloud storage buckets update "gs://$conversa_backup_bucket" \
  --lifecycle-file=/tmp/conversa-backup-lifecycle.json
```

Crea un secreto nuevo para la llave existente y publica su contenido por una tubería privada, sin mostrarlo. Si ya existe el secreto y una versión comprobada para esta llave, reutiliza su número en lugar de crear otra versión. `set -o pipefail` evita que un error del SSH se interprete como una carga correcta. No usar `set -x` ni grabar la salida de la llave.

```bash
set -o pipefail
gcloud secrets create conversa-master-key --replication-policy=automatic
gcloud compute ssh rastreoplus@conversa-app --zone=us-central1-a --ssh-flag=-T \
  --command='sudo docker exec conversa-demo-api-1 cat /run/conversa-keys/master.key' \
  | gcloud secrets versions add conversa-master-key --data-file=-
```

Anota el número de versión que devuelve Secret Manager. La huella local, que sí se puede consultar sin exponer la llave, se obtiene en SSH de la VM:

```bash
sudo docker exec conversa-demo-api-1 node --input-type=module -e \
  "import{readFileSync}from'node:fs';import{createHash}from'node:crypto';console.log(createHash('sha256').update(readFileSync('/run/conversa-keys/master.key')).digest('hex'))"
```

Identifica la cuenta de servicio adjunta a la VM y concede únicamente creación de objetos sobre ese bucket:

```bash
conversa_backup_writer=$(gcloud compute instances describe conversa-app --zone=us-central1-a \
  --format='value(serviceAccounts[0].email)')
gcloud storage buckets add-iam-policy-binding "gs://$conversa_backup_bucket" \
  --member="serviceAccount:$conversa_backup_writer" --role=roles/storage.objectCreator
```

Comprueba también los roles heredados del proyecto y los scopes de la VM. No basta añadir un rol limitado si la misma identidad sigue teniendo permisos amplios. Las llamadas deben permitir escribir en Cloud Storage; un scope `storage.read_only` no sirve. Cualquier cambio de cuenta de servicio/scopes de la VM requiere un procedimiento de mantenimiento propio; estos scripts no detienen ni reconfiguran la VM.

La identidad de recuperación debe tener `roles/storage.objectViewer` en el bucket y `roles/secretmanager.secretAccessor` en este secreto específico. No conceder el segundo rol a la identidad de la copia diaria. No descargar archivos JSON de cuentas de servicio para este procedimiento.

## Programar la copia en la VM

Después de fusionar y desplegar el PR, la imagen debe incluir `backend/offsite-backup.mjs`. El host necesita Docker, `gcloud` y `flock`. La tarea usa la cuenta de servicio de la VM a través de `gcloud`; no contiene un token de acceso fijo.

Crea `/etc/conversa-backup.conf` como root con modo `600`. Contiene solo referencias y la huella, no secretos. Sustituye VERSION por un número y HUELLA por los 64 caracteres verificados:

```bash
sudo install -m 600 /dev/null /etc/conversa-backup.conf
sudo nano /etc/conversa-backup.conf
```

```text
CONVERSA_BACKUP_BUCKET=conversa-app-511802-backups
CONVERSA_KEY_SECRET_VERSION=projects/conversa-app-511802/secrets/conversa-master-key/versions/VERSION
CONVERSA_MASTER_KEY_SHA256=HUELLA
```

Desde la carpeta del código nuevo:

```bash
sudo install -m 755 ops/backup-offsite.sh /usr/local/sbin/conversa-backup
sudo install -m 644 ops/systemd/conversa-backup.service /etc/systemd/system/
sudo install -m 644 ops/systemd/conversa-backup.timer /etc/systemd/system/
sudo /usr/local/sbin/conversa-backup
```

Solo si esa primera copia termina correctamente:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now conversa-backup.timer
sudo systemctl list-timers conversa-backup.timer
```

El timer ejecuta diariamente a las 06:30 UTC, **02:30 de Bolivia**, con hasta diez minutos de variación. La copia de SQLite usa su API de backup, no copia el archivo activo con `cp`. La copia resultante no depende del WAL/SHM del servidor. Publica primero SQLite y finalmente el manifiesto como marcador de finalización. Usa nombres únicos y `if-generation-match=0`, sin sobrescribir objetos anteriores.

El panel solo muestra una copia externa reciente cuando se completaron ambas cargas hace menos de 36 horas y no se registró un fallo posterior. Eso **no certifica una prueba de recuperación ni verifica por sí solo el estado del timer**. Revisa también:

```bash
sudo journalctl -u conversa-backup.service --since '2 days ago' --no-pager
```

Configura un aviso independiente si no aparece una copia nueva: el timer y el panel no notifican por correo. Las copias antiguas se depuran por el ciclo de vida del bucket. La tarea limpia sus archivos temporales tanto al completar como al fallar.

## Prueba real de restauración, antes de incorporar clientes

En una máquina de recuperación distinta de la VM original, usa una identidad autorizada para leer el bucket y la versión específica del secreto. Debe tener Docker y `gcloud`, además del código revisado. Construye una imagen sin arrancar la aplicación:

```bash
docker build -f backend/Dockerfile -t conversa-restore-check .
bash ops/check-restore.sh \
  gs://TU_BUCKET/conversa/ID_REAL/manifest.json conversa-restore-check
```

El script recupera el manifiesto y SQLite desde el bucket y la llave desde Secret Manager. Monta la copia como solo lectura en un contenedor **sin red**, verifica SHA-256, integridad SQLite, claves foráneas y descifrado de todas las cuentas, aplicaciones y autorizaciones temporales. No usa la base ni la llave de la VM original. No inicia API ni workers. Al terminar elimina el directorio temporal; registra únicamente el resultado y los nombres de los recursos, nunca tokens ni la llave.

Conserva evidencia con: fecha, identidad de recuperación, URI del manifiesto, versión del secreto, checksum y resultado `verified:true`. La fecha debe ser posterior a la creación del respaldo. Repite tras cambios de formato o rotación de llave y periódicamente según tu política. Las pruebas automáticas del repositorio usan datos sintéticos; no sustituyen esta prueba real de permisos y recuperación desde Google Cloud.

Si se pierde la VM, recupera en volúmenes nuevos la base y la llave comprobadas, asigna UID 1000 y permisos `600` a los archivos y `700` a los directorios. Usa el código compatible con ese respaldo. Antes de habilitar los workers revisa acciones pendientes y resultados inciertos: una copia antigua no permite saber qué envíos se completaron después de su fecha. No conectes la copia de prueba a Meta para comprobarla ni reenvíes pendientes sin conciliación. La pérdida máxima de datos entre copias diarias puede aproximarse a 24 horas, o más si falla una tarea.

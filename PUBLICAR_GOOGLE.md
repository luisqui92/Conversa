# Publicar Conversa en la VM de Google Cloud

**Ruta actual elegida por el usuario:** una VM de Google Cloud para Conversa, con DNS en ClouDNS y dominio `cc.chatgo.ia.bo`.

**Estado:** paquete preparado, todavía sin desplegar. Falta recibir la IP pública y el sistema operativo de la VM. No hay acceso a la cuenta de Google Cloud ni una sesión SSH conectados a este chat. No se creó ni modificó ninguna VM, regla de firewall o registro DNS desde aquí.

## Qué contiene el paquete

`conversa-google-vm.zip` contiene una carpeta `conversa-vm/` con:

- `dist/`: los seis archivos de la demo modular.
- `compose.vm.yaml`: servicio web Caddy, puertos TCP 80 y 443, persistencia de certificados y rotación de logs.
- `Caddyfile.vm`: dominio exacto, archivos estáticos, compresión, cabeceras y tipo JavaScript para `.mjs`.
- `deploy-vm.sh`: comprueba Compose, valida la configuración Caddy y arranca el servicio.
- Esta guía.

Solo `dist/` se sirve en la web. No se publican guías, prospectos, credenciales ni código de despliegue. Las rutas inexistentes no se redirigen al HTML como si hubiera una API.

## 1. Completar los datos de la VM

En Google Cloud Console → Compute Engine → Instancias de VM, identificar:

- Nombre de VM y proyecto.
- Sistema operativo y versión de la imagen.
- **IP externa/pública**, que será el destino DNS. No usar la IP interna.

Conviene reservar o promover esa IP externa a estática para mantener el DNS estable. Revisar los cargos aplicables de VM, disco y dirección IP; este paquete no confirma una tarifa ni garantiza costo cero. No hace falta crear otro servidor ni contratar otro proveedor para publicar la demo.

## 2. Permitir HTTP y HTTPS

La VM debe poder recibir tráfico de internet por **TCP 80 y TCP 443**. Revisar las reglas de firewall de Google Cloud aplicables a la red y las etiquetas de esta VM, además de cualquier firewall del sistema operativo.

En una VM nueva, la consola puede ofrecer permitir tráfico HTTP y HTTPS. Verificar que las reglas realmente se apliquen a esta instancia. No abrir todos los puertos ni desactivar el firewall.

Antes de iniciar Caddy, comprobar si otro servicio ya utiliza 80 o 443:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Si aparecen Nginx, Apache u otro servicio existente, integrar el dominio en ese servicio o revisar el despliegue antes de ocupar sus puertos. No parar servicios ajenos automáticamente.

## 3. DNS en ClouDNS

Abrir la zona `chatgo.ia.bo` y preparar:

| Campo | Valor |
|---|---|
| Tipo | A |
| Host | `cc` |
| Dirección | IP pública real de la VM |
| TTL | Predeterminado del proveedor, salvo necesidad concreta |

Si el formulario pide nombre completo, el resultado debe ser exactamente `cc.chatgo.ia.bo`. Revisar si ya existen A, AAAA o CNAME del mismo nombre: un registro que apunte a otro destino puede impedir el acceso o la emisión del certificado. Conservar los registros de los demás servicios. Un AAAA solo debe apuntar a una IPv6 realmente configurada en esta VM.

No se conoce aún la IP real, por lo que todavía no hay un valor final que copiar.

## 4. Preparar Docker según el sistema operativo

Usar las instrucciones oficiales de Docker Engine y el plugin Compose para la distribución elegida. No se incluye un instalador que modifique el sistema sin conocer su versión.

- [Docker Engine en Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- [Docker Engine en Debian](https://docs.docker.com/engine/install/debian/).
- [Plugin Compose](https://docs.docker.com/compose/install/linux/).

Verificar dentro de la VM:

```bash
sudo docker version
sudo docker compose version
```

Los comandos siguientes usan `sudo`, de modo que no hace falta añadir el usuario al grupo Docker. No se necesita entregar a este chat contraseñas, claves SSH ni claves de cuenta de servicio.

## 5. Subir e iniciar la demo

1. Descargar `conversa-google-vm.zip` desde el chat.
2. Abrir SSH desde la consola de Google Cloud para **esta VM**.
3. Usar la opción de cargar archivo de SSH en el navegador para subir el ZIP a la VM. Subirlo a Cloud Shell no es lo mismo que subirlo a la VM: si se usa Cloud Shell, hay que transferirlo luego a la instancia.
4. Extraer con `unzip` o con la herramienta de extracción disponible. Si no está instalada, instalarla con el gestor de paquetes de la distribución confirmada.
5. Entrar en la carpeta y arrancar:

```bash
unzip conversa-google-vm.zip
cd conversa-vm
sudo bash deploy-vm.sh
```

El script valida antes de arrancar. Necesita descargar la imagen oficial de Caddy si aún no está disponible. Publica la demo de manera accesible desde internet al quedar listo el DNS y HTTPS; la aplicación conserva la indicación de prototipo sin envíos reales.

Caddy solicita y renueva el certificado automáticamente cuando puede resolver el dominio y recibir las validaciones. El inicio del contenedor no confirma por sí solo que DNS o HTTPS ya funcionen.

## 6. Verificación

```bash
sudo docker compose -f compose.vm.yaml ps
sudo docker compose -f compose.vm.yaml logs --tail=80 web
curl -I https://cc.chatgo.ia.bo
```

Además, abrir la URL en un navegador y un móvil, revisar la navegación y simular dos publicaciones con fichas distintas. Verificar que los otros subdominios del negocio siguen disponibles.

Si falla el certificado, revisar primero DNS, IP, firewall y logs. Si hay registros CAA, comprobar que permitan a la autoridad de certificación usada por Caddy. No sustituir esta verificación por `curl --insecure` ni presentar el sitio como publicado mientras falle HTTPS.

## Operación posterior

Para cambios solo en HTML/CSS/JS, actualizar los archivos de `dist/`. Al estar montados en modo lectura dentro del contenedor, el servidor verá los archivos del host; no hace falta reconstruir la imagen. Publicar cambios completos para evitar mezclar versiones durante una actualización.

Si cambia la configuración Caddy:

```bash
sudo docker compose -f compose.vm.yaml exec web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker compose -f compose.vm.yaml exec web caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Para apagar solo este proyecto, manteniendo los volúmenes de certificados:

```bash
sudo docker compose -f compose.vm.yaml down
```

## Límites y comprobaciones de esta entrega

- Los 56 casos del motor y los módulos ya habían pasado en la entrega anterior. No se cambiaron sus archivos al preparar esta publicación.
- Se verificaron la sintaxis del script de despliegue, los archivos del paquete y el Compose por análisis local.
- **El contenedor Caddy y el certificado real no se ejecutaron ni verificaron en este entorno:** el acceso al socket Docker local fue denegado. El script incluye validación de Caddy para ejecutarla en la VM antes de iniciar el servicio.
- No hay backend, autenticación, aislamiento real de clientes, cobros, IA, Pixel ni conexiones de redes. Publicar esta demo no implementa esas funciones.
- Los datos se guardan en el navegador. Usar exportación/restauración JSON para mover datos desde una copia local al nuevo dominio.

## Fuentes oficiales

- [Caddy: requisitos de HTTPS](https://caddyserver.com/docs/quick-starts/https).
- [Caddy: HTTPS automático](https://caddyserver.com/docs/automatic-https).
- [Google Cloud: IP externa estática](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address).
- [Google Cloud: reglas de firewall](https://docs.cloud.google.com/firewall/docs/using-firewalls).

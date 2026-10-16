# Conversa

Prototipo de ChatGo / Lukmi SRL para gestionar consultas de inmuebles por publicación en Instagram, Facebook y TikTok.

**Los mensajes son simulados.** Esta versión no conecta cuentas sociales, no usa IA, no cobra suscripciones y no dispone de backend ni autenticación. Los datos se guardan en el navegador. Incluye ejemplos ficticios de venta, alquiler y anticrético, además de restaurantes.

## Instalar en la VM de Google Cloud

Requisitos: VM Linux con Docker Engine y el plugin Docker Compose. La VM preparada para este proyecto usa Ubuntu 24.04 x86_64; Docker ya fue comprobado por el usuario.

Desde SSH en la VM:

```bash
curl -fL https://github.com/luisqui92/Conversa/archive/refs/heads/main.zip -o conversa-github.zip
unzip conversa-github.zip
cd Conversa-main
sudo docker compose -f compose.vm.yaml config --quiet
```

Antes de arrancar, configurar el registro A `cc` de la zona `chatgo.ia.bo` en ClouDNS con la IP pública real de la VM y comprobar que llegan TCP 80 y 443. Conviene mantener una IP externa estática. No hay una IP preconfigurada en este repositorio.

Para consultar la IP desde la VM de Google Cloud:

```bash
curl -fsS -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip
printf '\n'
```

Cuando DNS y firewall estén listos:

```bash
sudo bash deploy-vm.sh
sudo docker compose -f compose.vm.yaml logs --tail=80 web
```

El despliegue usa Caddy para servir `dist/` y solicitar HTTPS para `cc.chatgo.ia.bo`. El script valida la configuración antes de arrancar. El contenedor iniciado no confirma por sí solo que DNS y el certificado estén listos: comprobar `https://cc.chatgo.ia.bo` en un navegador.

## Archivos

- `dist/`: HTML, estilos y módulos JavaScript de la aplicación.
- `compose.vm.yaml`: servicio web y volúmenes persistentes de certificados.
- `Caddyfile.vm`: dominio y configuración HTTP/HTTPS.
- `deploy-vm.sh`: validación y arranque del despliegue en la VM.
- `PUBLICAR_GOOGLE.md`: guía de publicación detallada.
- `checks.mjs`: 56 comprobaciones del flujo simulado.
- `package.py`: genera la demo autónoma para abrir sin instalación.

Para verificar el motor, con Node instalado:

```bash
node checks.mjs
```

Las comprobaciones del motor no prueban conexiones reales de redes sociales. La validación del contenedor y del certificado se debe completar en la VM.

## Desarrollo local

```bash
python3 -m http.server 8080 --directory dist
```

Abrir `http://localhost:8080`. No hace falta instalar dependencias JavaScript para usar la aplicación estática.

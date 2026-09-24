# INFO 1

Centro de estudio de Informática 1.

## Estado actual

- PWA preparada con `manifest.webmanifest` + `sw.js` + iconos.
- Persistencia local mediante `localStorage` e `IndexedDB`.
- Sincronización con el proyecto Supabase de SCAR mediante tablas separadas `info1_*`.
- Login/registro con Supabase Auth.
- Espacio compartido para Ile y Elías mediante `info1_workspaces` + `info1_members`.
- Estado completo sincronizado en `info1_state` con revisión simple para detectar conflictos.
- Bucket privado `info1-photos` preparado para fotos.
- Servidor Python local sigue siendo opcional para compatibilidad con el flujo Wi‑Fi/QR existente.

## Correcciones de fecha/calendario

- La cabecera muestra explícitamente **HOY**, fecha completa, hora y zona horaria del dispositivo.
- El calendario de actividad resalta el día actual.
- El detalle del calendario abre por defecto el día de hoy.
- Las fechas `YYYY-MM-DD` se interpretan en hora local para evitar el salto de un día por UTC.
- La vista se refresca automáticamente cuando cambia el día.

## Sincronización

La integración usa:

- `supabase-config.js`: URL y clave pública/publishable.
- `cloud-sync.js`: autenticación, creación/unión a workspace, subida y bajada de estado y aviso de cambios remotos.

La clave `service_role`/`sb_secret` nunca debe ir en el frontend.

## Ejecutar localmente

```bash
python3 -m http.server 8765
```

Abrí `http://localhost:8765/`.

## Subir la versión completa

El `index.html` del proyecto supera 1 MB. El ZIP preparado incluye `SUBIR_A_GITHUB.command`, que clona `ilean01/info1`, copia la versión completa y hace commit/push a `main`.

## Datos locales

`info1_wifi_data/` está ignorado por Git para no subir fotos ni datos locales al repositorio.

# INFO 1

Centro de estudio de Informática 1.

## Estado actual

- Web estática con `index.html` para publicar.
- PWA básica: `manifest.webmanifest` + `sw.js` + iconos.
- Persistencia local mediante `localStorage` e `IndexedDB`.
- Servidor local opcional en Python para carga de fotos por Wi‑Fi/QR.
- Backend compartido preparado en el mismo proyecto Supabase de SCAR con tablas `info1_*` y bucket privado `info1-photos`.

## Correcciones de fecha/calendario

- La cabecera muestra explícitamente **HOY**, fecha completa, hora y zona horaria del dispositivo.
- El calendario de actividad resalta el día actual.
- El detalle del calendario abre por defecto el día de hoy.
- Se corrigió un bug donde los botones del heatmap capturaban un objeto `Date` mutable y al pulsar días distintos podían mostrar una fecha equivocada.
- La vista se refresca automáticamente cuando cambia el día sin tener que recargar la página.

## Ejecutar localmente

Opción simple:

```bash
python3 -m http.server 8765
```

Abrí `http://localhost:8765/`.

Para conservar el servidor Wi‑Fi original y sus endpoints `/api/*`:

```bash
python3 info1_wifi_server.py
```

## Datos locales

`info1_wifi_data/` está ignorado por Git intencionalmente para no subir fotos ni datos locales al repositorio.

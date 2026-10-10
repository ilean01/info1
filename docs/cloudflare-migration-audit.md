# INFO 1 — Auditoría previa a migración Cloudflare

Fecha: 2026-10-10. Rama de trabajo: `migration/cloudflare-audit`.

## Alcance y seguridad
Este documento registra hallazgos de una lectura estática parcial de archivos en `main`. No se ejecutaron pruebas end-to-end, no se inspeccionó el dashboard de Supabase y no se exportaron datos. **No cambiar producción ni borrar Supabase hasta completar backups y validaciones.** INFO 1 comparte el proyecto Supabase con SCAR; migrar solo tablas y objetos `info1_*`.

## Evidencia revisada
- `README.md`: tablas `info1_workspaces`, `info1_members`, `info1_state`, `info1_photos`; bucket `info1-photos`; RLS y Realtime.
- `cloud-sync.js`: `notifyLocalSave()` programa `pushLocal` con 0 ms; la actualización de `info1_state` escribe `state:candidate` y usa `revision` para concurrencia; hay monitor periódico.
- `device-sync.js`: sincronización adicional y polling periódico, incluyendo `syncLatestData` cada 30 s.
- `notebooks-realtime.js`: canal de trazos, persistencia y múltiples temporizadores; revisión detallada de concurrencia pendiente.
- `state-storage.js`: persistencia IndexedDB de estado/cuadernos/assets y journal de tinta.
- `supabase-media-bridge.js`: `listPhotos` descarga blobs de cada foto listada y los convierte a data URL.
- `service-worker.js`: cache network-first de shell y archivos.

## Riesgos priorizados (hipótesis hasta medir)
1. **Alto — egress**: la sincronización del estado transmite documentos completos en lugar de deltas; las pizarras pueden agrandar ese documento. Medir tamaño/frecuencia real de peticiones.
2. **Alto — fotos**: `listPhotos` descarga todos los blobs de la consulta, incluso para obtener una lista. Implementar metadatos primero y descarga bajo demanda.
3. **Alto — pérdida de datos**: confirmar backups de Supabase, IndexedDB en Mac y tablet antes de migrar.
4. **Medio — concurrencia**: coexistencia de realtime, polling y envíos de estado; revisar carreras y conflictos por revisión.
5. **Medio — rendimiento**: revisar serializaciones de grandes objetos y temporizadores en la ruta del lápiz.

## Arquitectura propuesta (sin implementar todavía)
- Mantener frontend PWA en GitHub Pages.
- Cloudflare Worker: API autenticada, validación de pertenencia a workspace y sincronización incremental.
- D1: workspaces, miembros, progreso, sesiones, revisiones y operaciones idempotentes.
- R2: imágenes y archivos binarios, con acceso privado autorizado por Worker.
- Durable Objects + WebSockets: colaboración de pizarra; persistencia de operaciones y recuperación por secuencia.
- IndexedDB: cola local durable con ID de operación, reintentos, confirmaciones y resolución de conflictos.
- Autenticación: seleccionar y probar un proveedor seguro; nunca exponer claves privadas en frontend.

## Puertas de validación
1. Exportar esquema y filas de tablas INFO 1, objetos de bucket y copias locales de ambos dispositivos.
2. Comprobar métricas reales de Supabase egress antes de atribuir la causa.
3. Migrar esquema/datos en entorno de prueba; cotejar conteos, integridad y adjuntos.
4. Pruebas: offline, reconexión, ediciones simultáneas, cierres inesperados, duplicados, borrados y pizarras de gran tamaño.
5. Activar Cloudflare en producción solo tras confirmar equivalencia; mantener Supabase como respaldo temporal.

## Estado
Auditoría estática inicial completada; migración **NO iniciada**. No se modificó `main`.

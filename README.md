# INFO 1

Centro de estudio PWA de Informática 1 para Ile + Elías.

## Estado actual

- PWA publicada con GitHub Pages.
- `index.html` real restaurado y desplegado correctamente.
- Manifest, iconos para instalación y `service-worker.js` activos.
- Persistencia local mediante `localStorage` e `IndexedDB`.
- Fecha/hora local y calendario corregidos para no desplazar días por UTC.
- Contadores de parcial y recuperatorio.
- Perfiles separados de Ile y Elías, vista conjunta y red de conocimiento.
- Segundo parcial con PDA, NPDA, Gramáticas y Máquinas de Turing.
- Flashcards, simulacros, radar de examen, prioridades, cronómetro, errores y fotos.

## Supabase

INFO1 comparte el proyecto Supabase de SCAR sin mezclar sus datos. Usa objetos separados:

- `info1_workspaces`
- `info1_members`
- `info1_state`
- `info1_photos`
- bucket privado `info1-photos`

La sincronización del estado usa RLS y Realtime. `info1_state` está agregado a la publicación `supabase_realtime`, por lo que un cambio de otro dispositivo puede avisarse sin tener que recargar a ciegas.

Las fotos ahora se conectan directamente con Supabase mediante `supabase-media-bridge.js`. Cuando hay sesión de nube, las fotos de una ficha se almacenan en el bucket privado y sus metadatos en `info1_photos`; si se elige trabajar solo localmente, la aplicación conserva el fallback de IndexedDB.

El frontend usa únicamente una clave publishable. Nunca debe subirse una `service_role` ni otra clave secreta al repositorio.

## PWA / offline

`service-worker.js` usa el caché `info1-pwa-v3` e incluye el puente de fotos además del HTML, manifest, configuración de Supabase, sincronización e iconos. La estrategia actual intenta red primero y usa caché como respaldo.

## Despliegue

GitHub Pages despliega desde `main`. El último parche que habilita la sincronización de fotos fue desplegado correctamente.

El workflow `.github/workflows/info1-one-time-deploy.yml` conserva el mecanismo de recuperación del HTML grande a partir del payload verificado. El workflow `.github/workflows/info1-inject-media-bridge.yml` realizó la inyección controlada del puente de fotos en el HTML restaurado.

## Pendiente importante

El HTML contiene vistas que apuntan a PDFs bajo `materiales/` (por ejemplo las diapositivas del profesor). Esa carpeta todavía no está versionada en el repositorio, por lo que esos enlaces concretos deben cargarse o ajustarse antes de considerarlos terminados en GitHub Pages.

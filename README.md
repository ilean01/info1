# INFO 1

Centro de estudio de Informática 1.

## Estado actual

- Web estática/PWA preparada para GitHub Pages.
- Persistencia local mediante `localStorage` e `IndexedDB`.
- Sincronización compartida con Supabase mediante `supabase-config.js` y `cloud-sync.js`.
- Backend INFO1 aislado dentro del proyecto Supabase compartido con SCAR mediante tablas `info1_*` y bucket privado `info1-photos`.
- Correcciones de fecha/calendario aplicadas para zona horaria local.
- Los iconos PWA y `service-worker.js` ya están versionados en el repositorio.

## Estado del despliegue

El archivo `index.html` definitivo se reconstruye mediante `.github/workflows/info1-one-time-deploy.yml` a partir del payload XZ staged en `xzpayload/`. El workflow valida que el HTML sea completo, que tenga más de 500 KB y que cargue `supabase-config.js` y `cloud-sync.js` antes de reemplazar `index.html`.

## Supabase

La configuración cliente usa únicamente una clave publishable. No debe subirse ninguna `service_role` ni clave secreta al frontend.

## Materiales

El HTML referencia PDFs dentro de `materiales/`. Esos PDFs pesados todavía deben comprobarse/subirse por separado si se quiere que los enlaces internos funcionen desde GitHub Pages.

# INFO 1 — servidor local (prototipo de infraestructura)

**Estado:** backend inicial en rama de pruebas. **No está conectado aún al frontend**. No sustituye Supabase ni importa datos por sí solo.

## Preparación en Mac
Instalar Node.js 22 LTS o superior. Desde la carpeta del repositorio:

```bash
cd local-server
npm install
npm start
```

Se crea `local-server/data/info1.sqlite` y un token privado en `local-server/data/access-token`. Esta carpeta está excluida de Git. La Mac debe estar encendida para compartir la pizarra. Conectá Mac y tablet al mismo Wi-Fi, sin aislamiento entre clientes.

## Endpoints de preparación
- `GET /health`: comprobar servidor
- `GET /api/state?workspace=shared`: snapshot y revisión (Bearer token)
- `PUT /api/state`: snapshot con `expectedRevision`; devuelve 409 ante conflictos
- `GET /api/board-events?workspace=shared&board=...`: historial acotado
- `POST /api/backup`: copia SQLite en disco
- `WS /ws?workspace=shared&board=...&token=...`: canal de eventos de pizarra

**Limitaciones antes de uso real:** implementar el adaptador del frontend, autenticación usable sin poner el token en URLs, recuperación paginada de eventos, compactación, sincronización offline, prueba de concurrencia y restauración de backups. El token en query string de WS es solo para pruebas de LAN y puede quedar en registros; debe reemplazarse antes de producción. No abrir el puerto a internet.

## Migración segura
1. Copiar/exportar datos locales de la Mac y tablet y verificar respaldos.
2. Recuperar exportación de Supabase cuando esté disponible; no eliminar el proyecto.
3. Comparar las tres fuentes antes de consolidar: no sobreescribir ni deduplicar a ciegas.
4. Adaptar UI, fichas, horas y pizarras al backend local.
5. Probar en ambos dispositivos y recién entonces cambiar el arranque predeterminado.

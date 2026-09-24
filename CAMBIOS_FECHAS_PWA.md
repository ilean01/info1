# Corrección fecha/calendario + base PWA

## Fecha y calendario

1. Se agregó una franja **Hoy** con fecha completa, hora y zona horaria.
2. Se agregó un indicador de **Hoy** dentro de Actividad.
3. La celda del día actual tiene un contorno visible y `aria-current="date"`.
4. El detalle del heatmap empieza mostrando el día actual.
5. Se corrigió la captura del objeto `Date` mutable del bucle del heatmap usando una copia `cellDate` por celda.
6. Se agregó refresco automático cada 30 s y detección de cambio de día.

## PWA

1. `index.html` como entrada para hosting estático.
2. `manifest.webmanifest`.
3. `sw.js` para shell offline.
4. Iconos 192 y 512 px.
5. Metadatos iOS/tema en el HTML.

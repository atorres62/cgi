# CGI – Control de Aportaciones (app para celular)

Aplicación web instalable (PWA): funciona sin internet y guarda los datos **en el propio celular**.
No necesita servidor de base de datos ni tienda de aplicaciones.

## Módulos
| Pestaña | Contenido |
|---|---|
| **Personas** | Nombre, apellido paterno, apellido materno, teléfono, email, número de casa (alfanumérico), género, tipo (titular, arrendatario, esposa, hijo, sobrino, nieto, bisnieto, otro) y **Activo** (filtro de activas/inactivas). Muestra el estado de cuenta de cada persona. |
| **Ingresos** | Tipo (aportación mensual, reparación de lámparas, etc.), cantidad a aportar (tomada del tipo de ingreso), aportación, **adeudo = cantidad a aportar − aportación**, fecha. Si se aporta de más, la diferencia aparece como **saldo a favor** y se aplica automáticamente a la siguiente cuenta por pagar que se abra para esa persona. Botón **Abonar** para pagar el adeudo después. Botón **🧾 Cuentas por pagar**: crea un cargo a cada persona activa por cada tipo de ingreso con cantidad fija (sin duplicar si ya existe en ese mes). |
| **Gastos** | Tipo de gasto, fecha, importe gastado, descripción y **comprobantes**: fotos del ticket o factura (tomadas con la cámara o elegidas de la galería). |
| **Recibos** | Se generan solos al registrar un ingreso o un abono: folio consecutivo, fecha, nombre, concepto/tipo, importe y adeudo. Se pueden imprimir/guardar como PDF, o **enviar por WhatsApp como imagen** (con la firma). Botón **🔎 Folio** para consultar un recibo por su número. **Cancelar recibo** regresa el importe al adeudo del ingreso; el folio queda marcado como CANCELADO y no se vuelve a usar. |
| **Inicio** | Totales del mes (o de todo el periodo), saldo en caja y lista de adeudos. El adeudo de personas inactivas no se suma en los totales ni aparece en la lista de adeudos. |

En ⚙︎ **Configuración**: nombre de la asociación, **persona que recibe con su cargo y su firma digital**
(dibujada con el dedo o desde una foto de la firma en papel; aparecen en los recibos), tipos de ingreso con su **cantidad a aportar**
(vacía = monto variable que se captura en cada ingreso), tipos de gasto,
folio inicial, respaldo/restauración de datos y exportación a Excel (CSV).

## Cómo ponerla en el celular

Para instalarla y usarla sin internet, la app debe abrirse desde una dirección **https**. La forma más fácil y gratuita:

1. Entra a <https://app.netlify.com/drop> (o usa GitHub Pages).
2. Arrastra **esta carpeta completa** (`CGI`). Te dará una dirección como `https://algo.netlify.app`.
3. Abre esa dirección en el celular:
   - **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Agregar a pantalla principal*.
   - **iPhone (Safari):** botón Compartir → *Agregar a inicio*.

Solo para probar en la red de la casa: en la PC ejecuta `npx serve` dentro de la carpeta y abre
`http://IP-de-la-PC:3000` en el celular (así funciona, pero no se instala ni trabaja sin internet).

## Importante: respaldos
Los datos viven solo en el celular donde se capturan. Si se borra la app o los datos del navegador, se pierden.
Usa **⚙︎ → Descargar respaldo** con frecuencia (si pasan más de 7 días, Inicio muestra un aviso con el botón para descargarlo) y guarda el archivo en Drive, correo o WhatsApp.
Con **Restaurar respaldo** se pasan los datos a otro celular.

## Publicar cambios
Si modificas los archivos, cambia `CACHE = 'cgi-v1'` en `sw.js` (por ejemplo a `cgi-v2`) y vuelve a subir la carpeta;
los celulares tomarán la nueva versión la siguiente vez que abran la app.

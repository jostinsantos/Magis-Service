# Magis Service Catalog (repositorio para Nuvio/Lol-style RepoLoader)

Repositorio JavaScript independiente para la app anfitriona. No requiere modificar la app: el cargador lee `nuvio.json` (o `manifest.json`) y después descarga `index.js`.

## Funciones expuestas

- `getNews()` — novedades del launcher en una lista propia; no reutiliza un carrusel combinado de todos los tipos.
- `getHome()` — filas separadas de Novedades, Películas, Series y Animación, con las categorías/filas que entregue el servicio.
- `getCatalogs()` — catálogo por tipo.
- `getDiscoverFilters()` y `getDiscover(options)` — exploración por tipo y páginas de categorías cuando hay `columnId`.
- `search(query, options?)` — búsqueda de películas y series; puede filtrarse por tipo.
- `getMeta(id, options?)` — ficha del contenido y datos de temporadas/episodios si los devuelve el servicio.
- `getStreams(id, type, season, episode)` — solicita al servicio los datos de reproducción y devuelve la URL junto con los encabezados requeridos por el proveedor.

No usa TMDB. Los IDs y metadatos proceden del servicio API configurado. El formato de temporadas/episodios puede variar según el contenido devuelto por el proveedor.

## Instalar desde GitHub

1. Sube `nuvio.json`, `manifest.json`, `index.js` y este README a la raíz de un repositorio GitHub público.
2. En tu app, abre la instalación de repositorios y pega `usuario/repositorio` (o la URL del repositorio, según el campo que uses).
3. Si la app pide configuración, revisa los hosts, protocolo, App ID, versión y clave que correspondan a tu servicio.

El cargador de la app busca `nuvio.json`, `manifest.json` y `addon.json`, en ese orden. El archivo de entrada configurado es `index.js`.

## Configuración

Los valores predeterminados corresponden a los valores que la app de referencia contiene en su `MagisConfig.defaults`. Se pueden sobrescribir desde la configuración del repositorio si la app anfitriona expone esos campos. No publiques claves o datos de sesión que no tengas autorización para distribuir.

## Limitaciones y comprobación

- La app anfitriona debe permitir `fetch` y tener `CryptoJS` disponible; su runtime carga CryptoJS cuando detecta la referencia en el código.
- El servicio remoto puede cambiar hosts, parámetros, versión de API o estructura de respuestas. En ese caso hay que actualizar el adaptador de este repositorio, no las pantallas de la app.
- El código se ha validado sintácticamente, pero no se ha podido validar una sesión real contra el servicio remoto desde este entorno. Por eso, la disponibilidad efectiva depende de que el proveedor acepte los parámetros actuales.


## Correcciones 1.1.0
- Cachea respuestas de catálogo, búsqueda y fichas; comparte peticiones simultáneas.
- Evita la cadena de consultas de fallback cuando el servidor se queda esperando.
- Añade `getCatalog(catalogId, options)` para que las páginas de catálogo puedan cargar contenido.
- Las categorías se obtienen de las columnas que devuelve el servicio, en lugar de dejar las opciones vacías.
- `getNews()` conserva su lista independiente; las novedades no se mezclan con las filas de películas, series o animación.
- Normaliza los nombres, imágenes, descripciones, años, géneros, temporadas y episodios a los campos que consume la app.
- La inicialización de sesión anónima se comparte entre llamadas concurrentes.

Si un host no responde, el repositorio devuelve un resultado vacío/error en lugar de seguir lanzando una cadena ilimitada de solicitudes. Los tiempos límite dependen también del puente HTTP de la app anfitriona.


## Correcciones 1.2.0
- Conserva categorías de navegación aunque no incluyan elementos hasta abrirlas.
- Resuelve categorías que llegan identificadas por `columnCode` o `columnId`.
- Recuerda el tipo de contenido de películas, series y animación para consultar la ficha con el tipo correcto.
- Acepta envoltorios de respuesta `data`, `result` e `item` que algunas versiones del servicio utilizan.
- Amplía los alias de título, descripción y géneros para evitar fichas que solo muestran el ID.
- Acepta el tipo como segundo argumento de `getMeta` cuando el runtime lo pasa como texto.

La validación local comprueba sintaxis y empaquetado. La respuesta real depende del proveedor y debe verificarse con una sesión activa.

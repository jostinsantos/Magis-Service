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


## Correcciones 1.3.0
- El filtro de categorías cambia dinámicamente al tipo seleccionado y usa `getNextColumns` como en `MagisService.loadCategories`.
- Descubrir consulta `v3/getShelveData` para el catálogo raíz y las categorías, con IDs de columna reales.
- La ficha reconoce `assetData`, `simpleProgramList` y `sameSeasonSeriesList`, igual que `MagisCatalog.parseDetail`.
- Para IDs sin tipo conocido, la ficha prueba los tipos Magis de película y serie en vez de asumir siempre película.
- Las temporadas vinculadas se consultan con límite para recuperar los capítulos de cada temporada.


## Cambios 1.4.0

- Las categorías usan `columnId` real; `columnCode` ya no se envía como si fuera un ID de estantería.
- Descubrir solicita 20 elementos por página y limita la respuesta aunque el portal devuelva más elementos de los pedidos. La pantalla de la app puede seguir cargando páginas al desplazarse.
- Se guarda la relación entre serie, temporada, número de episodio y el `contentId` real del capítulo.
- `getStreams` ahora solicita `startPlayVOD` con el ID del episodio y el ID de la serie por separado, y selecciona la mejor variante de vídeo disponible.

**Validación:** sintaxis JavaScript y estructura ZIP verificadas. No se pudo hacer una prueba de reproducción contra el servicio remoto desde este entorno.


## Optimización 1.5.0 (sin retirar funciones)
- Añade caché de nivel público para Home, novedades, filtros, páginas de Descubrir, fichas y servidores; evita repetir cadenas de llamadas cuando la UI reconstruye widgets o cambia de pestaña.
- Comparte solicitudes simultáneas de la misma clave para reducir duplicados.
- Limita la memoria de caché y elimina entradas caducadas cuando crece, para evitar acumulación indefinida durante sesiones largas.
- Ajusta la separación mínima entre peticiones de 400 ms a 250 ms, manteniendo el orden de la cola para no disparar llamadas concurrentes al portal.
- Mantiene las funciones de catálogo, filtros, fichas, temporadas, episodios y reproducción.

**Nota:** esta optimización reduce trabajo repetido del repositorio, pero no puede garantizar por sí sola eliminar el diálogo Android «La app no responde». Si persiste incluso con menos llamadas, el bloqueo puede estar en el runtime JavaScript/puente HTTP de la app anfitriona y requerir mover esa ejecución fuera del hilo principal.

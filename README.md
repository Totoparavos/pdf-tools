## ¿Por qué unir no es simplemente "pegar" dos archivos?

No es lo mismo porque al copiar el texto de uno sobre el otro, la estructura interna de ambos se pisa entre sí. Esto impide decidir correctamente qué fuentes, textos, imágenes y demás objetos de cada archivo deben ir primero y cuáles después.

Además, como ambos documentos empiezan a numerar sus objetos desde el 1, esos números chocarían entre sí y el documento final quedaría corrupto.

Para unirlos bien, no se "pegan" los archivos, sino que se leen las páginas de cada uno, se crea un documento nuevo desde cero, y se insertan ahí. De esta forma, la librería (pdf-lib) se encarga de reescribir y renumerar todos los objetos para que el archivo final sea válido.
# Manga Companion

Please build a full-stack web application based exactly on the attached `manga-translator.html` file. Replicate the user interface, sidebar settings, toggle switches, grid page cards, and canvas comparison layouts identically.



Modify the execution plumbing completely to eliminate external dependencies:

- Completely remove the API Key credential input row from the sidebar. 

- Create an automated backend server handling data manipulation. When a user uploads a .cbz manga archive, parse the images through a backend pipeline.

- Implement an open-source text extraction and translation layer directly on the server environment. Use a free node package like Tesseract for reading the Japanese/source characters, and a community-driven free translation router to map it to the requested target language.

- Return the translation mapping arrays directly to the canvas frontend to handle the text block masking overlays.

- Ensure all mobile browser sandboxing barriers are resolved by managing the file stream uploads through standard form-data post requests to the server.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0ec9c145-290c-4c72-bd37-cb92cec6adf8).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

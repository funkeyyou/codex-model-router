# Provider icons

These SVG files identify the providers listed in the manager's "Common providers" picker.

- Source: [CC Switch](https://github.com/farion1231/cc-switch) `src/icons/extracted/` (MIT License), commit
  `96d636ca1009fe7df293fd66f0072d14be2305be`. Most of these icons originate from
  [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT License).
- The logos and names are trademarks of their respective owners and are used only to identify each service.
  This project is not affiliated with or endorsed by any of them.

`node tools/provider-icons.mjs` embeds these files into `src/manager.html` as `data:` images. Edit the SVG files
here, never the embedded copy.

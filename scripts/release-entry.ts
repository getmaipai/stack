import indexHtml from "../frontend/dist/index.html" with { type: "file" };
import indexJs from "../frontend/dist/assets/index.js" with { type: "file" };
import indexCss from "../frontend/dist/assets/index.css" with { type: "file" };
import icon from "../frontend/dist/brand/maipai-stack-icon-light.png" with { type: "file" };
import "../backend/src/index";

void [indexHtml, indexJs, indexCss, icon];

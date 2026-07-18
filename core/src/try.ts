import { readFileSync } from "node:fs";
import { format } from "./format.js";
import type { StyleTemplate } from "./style-template.js";

const templatePath = process.argv[2];
const sqlPath = process.argv[3];

const template = JSON.parse(readFileSync(templatePath, "utf8")) as StyleTemplate;
const sql = readFileSync(sqlPath, "utf8");

console.log(format(sql, template));

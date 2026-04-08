#!/usr/bin/env node

import "dotenv/config";
import { createProgram } from "./program.js";

createProgram().parse();

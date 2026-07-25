import { ContentCreator } from "./contentCreator.ts";
import { Manager } from "./manager.ts";

const manager = await Manager.load("main");

const cc = await ContentCreator.load("head");
cc?.setManager(manager);

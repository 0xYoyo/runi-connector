import { startMockReichman } from "./mock-reichman";
startMockReichman(8799).then(({ base }) => console.log(`mock reichman on ${base}`));

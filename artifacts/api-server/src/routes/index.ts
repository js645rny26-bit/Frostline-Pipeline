import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pipelineRouter from "./pipeline";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pipelineRouter);

export default router;

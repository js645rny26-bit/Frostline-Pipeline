import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pipelineRouter from "./pipeline";
import workbookRouter from "./workbook";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pipelineRouter);
router.use(workbookRouter);

export default router;

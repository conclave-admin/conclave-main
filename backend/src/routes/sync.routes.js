const router=require('express').Router();
router.use(require('../middlewares/auth.middleware'));
router.get('/',require('../utils/asyncHandler')(async(req,res)=>require('../utils/apiResponse').ok(res,await require('../services/sync.service').replay(req.user.id,req.query.after))));
module.exports=router;

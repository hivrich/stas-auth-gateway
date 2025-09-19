// Middleware для валидации и извлечения user_id
function validateUserId(req, res, next) {
  // Источники user_id: query, body, или из OAuth токена
  const userIdRaw = req.query.user_id || req.body?.user_id || req.user?.sub;
  
  if (!userIdRaw) {
    return res.status(400).json({ 
      error: 'user_id is required', 
      message: 'Please provide user_id as query parameter, request body, or in OAuth token' 
    });
  }
  
  const userId = Number(userIdRaw);
  
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ 
      error: 'Invalid user_id format', 
      message: 'user_id must be a positive integer' 
    });
  }
  
  // Сохраняем валидированный user_id в req для использования в роутах
  req.validatedUserId = userId;
  next();
}

module.exports = { validateUserId };

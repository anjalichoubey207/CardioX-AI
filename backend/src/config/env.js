import dotenv from 'dotenv';
dotenv.config();

export const config = {
  PORT: process.env.PORT || 5000,
  WS_PORT: process.env.WS_PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // JWT Security
  JWT_SECRET: process.env.JWT_SECRET || 'cardiox_super_secret_jwt_key_2026_clinical_access',
  JWT_EXPIRATION: process.env.JWT_EXPIRATION || '24h',
  REFRESH_TOKEN_EXPIRATION: '7d',

  // MySQL Database Config
  DB: {
    HOST: process.env.DB_HOST || 'localhost',
    PORT: process.env.DB_PORT || 3306,
    USER: process.env.DB_USER || 'root',
    PASSWORD: process.env.DB_PASSWORD || 'rootpassword',
    NAME: process.env.DB_NAME || 'cardiox_db'
  },

  // AI Service URL (FastAPI)
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || 'http://localhost:8000',

  // Safety Disclaimers
  DISCLAIMER: 'This is AI-assisted monitoring support and not a medical diagnosis. Consult a qualified physician for clinical care.'
};

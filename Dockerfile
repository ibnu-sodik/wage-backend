FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 8001

# Start application
CMD ["npm", "start", "dev"]

FROM node:18-alpine

# Install crond
RUN apk add --no-cache dcron

WORKDIR /app

# Copy rest of the source code
COPY . .

# Install dependencies
RUN npm install

# Build TypeScript
RUN npm run build

# Create log directory
RUN mkdir -p /var/log/cron

# Add crontab file
COPY crontab /etc/crontabs/root

# Script to run both crond and tail logs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run the entrypoint script
CMD ["/entrypoint.sh"] 
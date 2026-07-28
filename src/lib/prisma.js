const { PrismaClient } = require('@prisma/client');

// Sdílená singleton instance — zabrání vyčerpání DB connection poolu
const prisma = new PrismaClient();

module.exports = prisma;

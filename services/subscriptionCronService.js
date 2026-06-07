/**
 * Subscription Cron Service - Node.js Implementation
 * 
 * File: /home/noorsa-ti/dev_docker/webserver/wage-backend/services/subscriptionCronService.js
 * 
 * Usage:
 * node services/subscriptionCronService.js
 * 
 * Atau integrate dengan scheduler:
 * const SubscriptionCron = require('./subscriptionCronService');
 * const cron = require('node-cron');
 * 
 * // Run every day at midnight
 * cron.schedule('0 0 * * *', () => {
 *   SubscriptionCron.checkAndSuspendExpired();
 * });
 */

const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

class SubscriptionCronService {
  /**
   * Check dan suspend subscription yang sudah expired
   */
  static async checkAndSuspendExpired() {
    const result = {
      success: false,
      message: '',
      suspendedCount: 0,
      affectedUsers: [],
      errors: []
    };

    try {
      console.log('\n╔════════════════════════════════════════════════════════════╗');
      console.log('║  SUBSCRIPTION EXPIRY CHECK CRON JOB                        ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('Started at:', new Date().toLocaleString());

      const startTime = Date.now();

      // 1. Query subscription yang ACTIVE tapi CURRENT_PERIOD_END sudah terlewat
      const query = `
        SELECT 
          si.ID,
          si.USER_ID,
          si.CURRENT_PERIOD_END,
          su.EMAIL,
          su.FIRST_NAME,
          su.LAST_NAME
        FROM subscription_instance si
        LEFT JOIN sysuser su ON si.USER_ID = su.ID
        WHERE si.STATUS = 'ACTIVE'
          AND si.CURRENT_PERIOD_END < NOW()
          AND si.CANCEL_AT_PERIOD_END = 0
          AND si.CANCELLED_AT IS NULL
        ORDER BY si.CURRENT_PERIOD_END DESC
      `;

      const [expiredSubscriptions] = await db.execute(query);

      if (expiredSubscriptions.length === 0) {
        result.success = true;
        result.message = 'Tidak ada subscription yang expired.';
        console.log('✓ ' + result.message);
        return this.printResult(result, Date.now() - startTime);
      }

      // 2. Loop setiap subscription dan suspend
      for (const subscription of expiredSubscriptions) {
        try {
          const { ID, USER_ID, CURRENT_PERIOD_END, EMAIL, FIRST_NAME } = subscription;

          // Start transaction
          const connection = await db.getConnection();
          await connection.beginTransaction();

          try {
            // Update subscription status ke SUSPENDED
            const updateQuery = `
              UPDATE subscription_instance 
              SET STATUS = 'SUSPENDED', UPDATED_AT = NOW()
              WHERE ID = ?
            `;

            const [updateResult] = await connection.execute(updateQuery, [ID]);

            if (updateResult.affectedRows > 0) {
              // Insert history entry
              const historyId = uuidv4();
              const historyQuery = `
                INSERT INTO subscription_history 
                (ID, SUBSCRIPTION_ID, USER_ID, ACTION, NOTE, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, 'SUSPENDED', ?, NOW(), NOW())
              `;

              const note = `Automatic suspension: Subscription period berakhir pada ${CURRENT_PERIOD_END}`;
              await connection.execute(historyQuery, [historyId, ID, USER_ID, note]);

              // Record affected user
              result.affectedUsers.push({
                userId: USER_ID,
                subscriptionId: ID,
                email: EMAIL,
                name: FIRST_NAME,
                periodEnd: CURRENT_PERIOD_END,
                status: 'SUSPENDED'
              });

              result.suspendedCount++;

              console.log(`✓ Suspended: ${FIRST_NAME} (${EMAIL})`);
            }

            // Commit transaction
            await connection.commit();
            connection.release();

          } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
          }

        } catch (error) {
          result.errors.push({
            subscriptionId: subscription.ID,
            error: error.message
          });
          console.error(`✗ Error suspending ${subscription.ID}: ${error.message}`);
        }
      }

      result.success = true;
      result.message = `${result.suspendedCount} subscription(s) telah di-suspend.`;

      return this.printResult(result, Date.now() - startTime);

    } catch (error) {
      result.success = false;
      result.message = `Error: ${error.message}`;
      console.error('Error:', error);
      return this.printResult(result, Date.now() - Date.now());
    }
  }

  /**
   * Print formatted result
   */
  static printResult(result, executionTime) {
    const status = result.success ? '[✓ SUCCESS]' : '[✗ FAILED]';

    console.log(`\nStatus: ${status}`);
    console.log(`Message: ${result.message}`);
    console.log(`Subscriptions Suspended: ${result.suspendedCount}`);
    console.log(`Execution Time: ${executionTime}ms`);

    if (result.affectedUsers.length > 0) {
      console.log('\n--- Suspended Subscriptions ---');
      result.affectedUsers.forEach((user, idx) => {
        console.log(`${idx + 1}. ${user.name} (${user.email})`);
        console.log(`   Period End: ${user.periodEnd}`);
        console.log(`   Subscription ID: ${user.subscriptionId}\n`);
      });
    }

    if (result.errors.length > 0) {
      console.log('\n--- Errors ---');
      result.errors.forEach((err) => {
        console.log(`✗ ${err.subscriptionId}: ${err.error}`);
      });
    }

    console.log(`\nFinished at: ${new Date().toLocaleString()}\n`);

    return result;
  }

  /**
   * Get subscription stats
   */
  static async getStats() {
    try {
      const query = `
        SELECT 
          STATUS,
          COUNT(*) as count
        FROM subscription_instance
        GROUP BY STATUS
      `;

      const [stats] = await db.execute(query);
      return stats;
    } catch (error) {
      console.error('Error getting stats:', error);
      return [];
    }
  }

  /**
   * Get expiring soon subscriptions (warning)
   */
  static async getExpiringSoon(daysUntilWarning = 3) {
    try {
      const query = `
        SELECT 
          ID,
          USER_ID,
          CURRENT_PERIOD_END,
          DATEDIFF(CURRENT_PERIOD_END, NOW()) as daysUntilExpiry
        FROM subscription_instance
        WHERE STATUS = 'ACTIVE'
          AND DATEDIFF(CURRENT_PERIOD_END, NOW()) <= ?
          AND DATEDIFF(CURRENT_PERIOD_END, NOW()) > 0
        ORDER BY CURRENT_PERIOD_END ASC
      `;

      const [expiring] = await db.execute(query, [daysUntilWarning]);
      return expiring;
    } catch (error) {
      console.error('Error getting expiring subscriptions:', error);
      return [];
    }
  }
}

// Run jika dijalankan directly
if (require.main === module) {
  SubscriptionCronService.checkAndSuspendExpired()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = SubscriptionCronService;
